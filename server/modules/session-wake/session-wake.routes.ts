import express, { type NextFunction, type Request, type Response } from 'express';

import type { LLMProvider } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { wakeSession, type ProviderSpawnFn } from './session-wake.service.js';
import { consumeWakeToken } from './wake-token.service.js';

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Lets the wake endpoint be called two ways: a normal end-user JWT (the
 * existing `authenticateToken` middleware, injected from the composition
 * root same as `spawnFns`), or a one-time internal token minted for a single
 * background job (see wake-token.service.ts) and presented via
 * `X-Wake-Token`. The internal path never sees or needs the user's JWT.
 */
function createWakeAuthMiddleware(authenticateToken: AuthMiddleware): AuthMiddleware {
  return (req, res, next) => {
    const wakeToken = req.headers['x-wake-token'];
    if (typeof wakeToken === 'string' && wakeToken.length > 0) {
      const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
      if (!consumeWakeToken(sessionId, wakeToken)) {
        res.status(401).json({ error: 'Invalid or expired wake token.' });
        return;
      }
      (req as unknown as { user?: unknown }).user = { id: null, internal: true };
      next();
      return;
    }

    authenticateToken(req, res, next);
  };
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

function parseSessionId(value: unknown): string {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError('Invalid sessionId.', { code: 'INVALID_SESSION_ID', statusCode: 400 });
  }
  return sessionId;
}

function parsePrompt(body: unknown): string {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const prompt = record ? record.prompt : undefined;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new AppError('prompt is required.', { code: 'PROMPT_REQUIRED', statusCode: 400 });
  }
  return prompt;
}

/**
 * POST /api/sessions/:sessionId/wake
 *
 * Lets a headless caller (a finished background job, a cron trigger, ...)
 * inject a turn into a session with no browser tab attached. See
 * session-wake.service.ts for why this exists and how delivery works without
 * a live socket.
 *
 * `spawnFns` comes from the same composition root (server/index.js) that
 * wires the identical map into the chat websocket server.
 */
export function createSessionWakeRoutes(
  spawnFns: Record<LLMProvider, ProviderSpawnFn>,
  authenticateToken: AuthMiddleware
) {
  const router = express.Router();
  const wakeAuthMiddleware = createWakeAuthMiddleware(authenticateToken);

  router.post(
    '/:sessionId/wake',
    wakeAuthMiddleware,
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = parseSessionId(req.params.sessionId);
      const prompt = parsePrompt(req.body);
      const user = (req as unknown as { user?: { id?: string | number; userId?: string | number } }).user;
      const userId = user?.id ?? user?.userId ?? null;

      const result = await wakeSession(spawnFns, { sessionId, prompt, userId });
      res.status(202).json(createApiSuccessResponse(result));
    }),
  );

  return router;
}
