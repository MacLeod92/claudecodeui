import crypto from 'crypto';

/**
 * Short-lived, single-use tokens that let a background job self-report its
 * completion back to `POST /api/sessions/:sessionId/wake` without needing
 * the end user's JWT (the shell command has no access to it, and shouldn't
 * need to). Minted server-side when a background command is spawned
 * (server/claude-sdk.js's `canUseTool` rewrite), scoped to the one session
 * that spawned it, and consumed on first use.
 */

const WAKE_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // background jobs can run long; generous but bounded

interface WakeTokenEntry {
  appSessionId: string;
  expiresAt: number;
}

const wakeTokens = new Map<string, WakeTokenEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [token, entry] of wakeTokens) {
    if (entry.expiresAt <= now) {
      wakeTokens.delete(token);
    }
  }
}

export function mintWakeToken(appSessionId: string): string {
  pruneExpired();
  const token = crypto.randomBytes(24).toString('hex');
  wakeTokens.set(token, { appSessionId, expiresAt: Date.now() + WAKE_TOKEN_TTL_MS });
  return token;
}

/** Single-use: valid tokens are removed on first (successful or failed) check. */
export function consumeWakeToken(appSessionId: string, token: string): boolean {
  const entry = wakeTokens.get(token);
  if (!entry) {
    return false;
  }
  wakeTokens.delete(token);
  return entry.expiresAt > Date.now() && entry.appSessionId === appSessionId;
}
