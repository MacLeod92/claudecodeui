/**
 * Generic per-user UI preferences repository.
 *
 * Stores an arbitrary, feature-agnostic JSON blob per user. Callers own the
 * shape and meaning of the keys they read/write; this layer only merges and
 * persists them.
 */

import { getConnection } from '@/modules/database/connection.js';

type UiPreferences = Record<string, unknown>;

function parsePreferences(json: string | undefined): UiPreferences {
  if (!json) {
    return {};
  }
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as UiPreferences : {};
  } catch {
    return {};
  }
}

export const uiPreferencesDb = {
  /** Returns the stored preferences for a user, or null if none have been saved yet. */
  getPreferences(userId: number): UiPreferences | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT preferences_json FROM user_ui_preferences WHERE user_id = ?')
      .get(userId) as { preferences_json: string } | undefined;

    if (!row) {
      return null;
    }

    return parsePreferences(row.preferences_json);
  },

  /** Shallow-merges the given partial preferences into the stored blob and returns the result. */
  updatePreferences(userId: number, partialPreferences: UiPreferences): UiPreferences {
    const db = getConnection();
    const existing = uiPreferencesDb.getPreferences(userId) ?? {};
    const merged = { ...existing, ...partialPreferences };

    db.prepare(
      `INSERT INTO user_ui_preferences (user_id, preferences_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         preferences_json = excluded.preferences_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, JSON.stringify(merged));

    return merged;
  },
};
