import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { uiPreferencesDb } from '@/modules/database/repositories/ui-preferences.js';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'ui-preferences-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    const db = getConnection();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run('test-user', 'hash');
    await runTest(Number(lastInsertRowid));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('getPreferences returns null before anything has been saved', async () => {
  await withIsolatedDatabase((userId) => {
    assert.equal(uiPreferencesDb.getPreferences(userId), null);
  });
});

test('updatePreferences persists and round-trips a value', async () => {
  await withIsolatedDatabase((userId) => {
    const result = uiPreferencesDb.updatePreferences(userId, { permissionMode: 'plan' });
    assert.deepEqual(result, { permissionMode: 'plan' });
    assert.deepEqual(uiPreferencesDb.getPreferences(userId), { permissionMode: 'plan' });
  });
});

test('updatePreferences shallow-merges without clobbering unrelated keys', async () => {
  await withIsolatedDatabase((userId) => {
    uiPreferencesDb.updatePreferences(userId, { permissionMode: 'plan', theme: 'dark' });
    const result = uiPreferencesDb.updatePreferences(userId, { permissionMode: 'default' });

    assert.deepEqual(result, { permissionMode: 'default', theme: 'dark' });
    assert.deepEqual(uiPreferencesDb.getPreferences(userId), { permissionMode: 'default', theme: 'dark' });
  });
});

test('getPreferences logs and falls back to {} when stored JSON is malformed', async () => {
  await withIsolatedDatabase((userId) => {
    const db = getConnection();
    db.prepare(
      `INSERT INTO user_ui_preferences (user_id, preferences_json) VALUES (?, ?)`
    ).run(userId, '{not valid json');

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };

    try {
      assert.deepEqual(uiPreferencesDb.getPreferences(userId), {});
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), new RegExp(`user ${userId}`));
  });
});

test('preferences are isolated per user', async () => {
  await withIsolatedDatabase((userId) => {
    const db = getConnection();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run('other-user', 'hash');
    const otherUserId = Number(lastInsertRowid);

    uiPreferencesDb.updatePreferences(userId, { theme: 'dark' });
    uiPreferencesDb.updatePreferences(otherUserId, { theme: 'light' });

    assert.deepEqual(uiPreferencesDb.getPreferences(userId), { theme: 'dark' });
    assert.deepEqual(uiPreferencesDb.getPreferences(otherUserId), { theme: 'light' });
  });
});
