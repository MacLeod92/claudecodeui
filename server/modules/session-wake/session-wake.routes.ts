import express, { type Request, type Response } from 'express';

import type { LLMProvider } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { wakeSession, type ProviderSpawnFn } from './session-wake.service.js';

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
export function createSessionWakeRoutes(spawnFns: Record<LLMProvider, ProviderSpawnFn>) {
  const router = express.Router();

  router.post(
    '/:sessionId/wake',
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
