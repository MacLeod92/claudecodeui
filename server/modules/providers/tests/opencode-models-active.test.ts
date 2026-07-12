import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { OpenCodeProviderModels } from '@/modules/providers/list/opencode/opencode-models.provider.js';

async function withIsolatedEnvironment(
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'opencode-active-model-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.HOME = tempDirectory;
  await initializeDatabase();

  const opencodeDataDir = path.join(tempDirectory, '.local', 'share', 'opencode');
  await import('node:fs/promises').then((fs) => fs.mkdir(opencodeDataDir, { recursive: true }));
  const opencodeDbPath = path.join(opencodeDataDir, 'opencode.db');
  const opencodeDb = new Database(opencodeDbPath);
  opencodeDb.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      model TEXT,
      agent TEXT,
      directory TEXT,
      time_updated INTEGER,
      time_created INTEGER
    );
  `);
  opencodeDb.close();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function insertOpenCodeSessionRow(
  homeDir: string,
  sessionId: string,
  model: string,
): void {
  const opencodeDbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
  const opencodeDb = new Database(opencodeDbPath);
  opencodeDb
    .prepare('INSERT INTO session (id, model, time_created) VALUES (?, ?, ?)')
    .run(sessionId, model, Date.now());
  opencodeDb.close();
}

test('getCurrentActiveModel translates the app session id to the provider-native id', async () => {
  await withIsolatedEnvironment(async () => {
    const homeDir = process.env.HOME as string;

    sessionsDb.createAppSession('app-id-1', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-id-1', 'ses_native_123');
    insertOpenCodeSessionRow(homeDir, 'ses_native_123', 'anthropic/claude-sonnet-4-5');

    const provider = new OpenCodeProviderModels();
    const result = await provider.getCurrentActiveModel('app-id-1');

    assert.equal(result.model, 'anthropic/claude-sonnet-4-5');
  });
});

test('getCurrentActiveModel falls back to the catalog default when no mapping exists', async () => {
  await withIsolatedEnvironment(async () => {
    const provider = new OpenCodeProviderModels();
    const result = await provider.getCurrentActiveModel('unmapped-session-id');

    // No sessions row and no matching opencode session row: falls through to
    // the provider's default model rather than throwing.
    assert.ok(result.model);
  });
});
