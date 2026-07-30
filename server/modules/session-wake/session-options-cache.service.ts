import type { AnyRecord } from '@/shared/types.js';

/**
 * Remembers the last-used chat options for a session so `wakeSession` can
 * resume with the same `permissionMode`/`toolsSettings`/`model`/`effort` a
 * live `chat.send` would have carried. Without this, a headless wake (the
 * background-job self-report curl, or an in-process `task_notification`
 * follow-up) starts a run with none of those options set, silently dropping
 * things like an `auto`/`bypassPermissions` permission mode back to normal
 * per-tool approval. Options are per-session, in-memory only, and simply
 * overwritten on every real `chat.send` — no persistence, no expiry needed
 * (the entry is only ever as stale as the last real turn on that session).
 */

const REMEMBERED_OPTION_KEYS = ['permissionMode', 'toolsSettings', 'model', 'effort'] as const;

const rememberedOptions = new Map<string, AnyRecord>();

export function rememberSessionOptions(appSessionId: string, options: AnyRecord): void {
  const picked: AnyRecord = {};
  for (const key of REMEMBERED_OPTION_KEYS) {
    if (options[key] !== undefined) {
      picked[key] = options[key];
    }
  }
  rememberedOptions.set(appSessionId, picked);
}

export function getRememberedSessionOptions(appSessionId: string): AnyRecord {
  return rememberedOptions.get(appSessionId) ?? {};
}
