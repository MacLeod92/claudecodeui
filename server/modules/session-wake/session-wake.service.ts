import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider, RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

// `writer` is intentionally untyped (`AnyRecord`'s index signature covers
// it): each provider runtime's actual writer parameter type is narrower
// (and mutually incompatible) than `unknown` under contravariance, so this
// mirrors how chat-websocket.service.ts's own ProviderSpawnFn type is only
// checked at the (untyped, plain-JS) index.js call site rather than against
// the real runtime signatures here.
export type ProviderSpawnFn = (command: string, options: AnyRecord, writer: AnyRecord) => Promise<unknown>;

/**
 * A connection that never reports itself "open". The run registry still
 * sequences and buffers every event through this writer exactly like a real
 * socket (so a client that later reconnects via `chat.subscribe` can replay
 * whatever hasn't completed yet, and the completed transcript is always
 * available over REST history) — but nothing is ever pushed over a socket
 * that doesn't exist. This is what lets `wakeSession` start a turn on a
 * session with no browser tab attached at all.
 */
const HEADLESS_CONNECTION: RealtimeClientConnection = {
  readyState: 3, // WebSocket.CLOSED — never equals WS_OPEN_STATE (1)
  send: () => {},
};

/**
 * Starts a turn on a session on behalf of a headless caller (a finished
 * background job, a cron trigger, ...) instead of a live `chat.send` from the
 * browser. Used to close the gap where background work finishes with no tab
 * open to receive it: the turn runs and completes on its own, the transcript
 * and REST history pick it up normally, and the existing push-notification
 * channel (desktop/web-push, fired from inside the provider runtime's own
 * hooks) tells the user it's done.
 *
 * Deliberately fire-and-forget: the caller doesn't wait for Claude's
 * response, only for the run to be accepted.
 *
 * `spawnFns` is injected rather than imported directly: the concrete
 * provider runtimes (claude-sdk.js, cursor-cli.js, ...) live at the top of
 * server/, outside any module boundary, so server/index.js — the existing
 * composition root that already builds this same map for the chat websocket
 * — is the only place allowed to wire them in.
 */
export async function wakeSession(
  spawnFns: Record<LLMProvider, ProviderSpawnFn>,
  input: {
    sessionId: string;
    prompt: string;
    userId: string | number | null;
  }
): Promise<{ accepted: true }> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    throw new AppError(`Session "${input.sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  const provider = session.provider as LLMProvider;
  const spawnFn = spawnFns[provider];
  if (!spawnFn) {
    throw new AppError(`Provider "${provider}" is not available.`, {
      code: 'UNSUPPORTED_PROVIDER',
      statusCode: 422,
    });
  }

  const run = chatRunRegistry.startRun({
    appSessionId: input.sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: HEADLESS_CONNECTION,
    userId: input.userId,
  });

  if (!run) {
    throw new AppError(`Session "${input.sessionId}" already has a run in progress.`, {
      code: 'RUN_IN_PROGRESS',
      statusCode: 409,
    });
  }

  const runtimeOptions: AnyRecord = {
    sessionId: session.provider_session_id ?? undefined,
    resume: Boolean(session.provider_session_id),
    cwd: session.project_path ?? undefined,
    projectPath: session.project_path ?? undefined,
  };

  void spawnFn(input.prompt, runtimeOptions, run.writer)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SessionWake] Provider runtime "${provider}" failed`, {
        sessionId: input.sessionId,
        error: message,
      });
    })
    .finally(() => {
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    });

  return { accepted: true };
}
