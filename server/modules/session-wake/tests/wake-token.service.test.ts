import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeWakeToken, mintWakeToken } from '@/modules/session-wake/wake-token.service.js';

test('mintWakeToken produces a token that consumeWakeToken accepts exactly once for the right session', () => {
  const token = mintWakeToken('session-a');

  assert.equal(consumeWakeToken('session-a', token), true);
  assert.equal(consumeWakeToken('session-a', token), false, 'token must be single-use');
});

test('consumeWakeToken rejects a token minted for a different session', () => {
  const token = mintWakeToken('session-a');

  assert.equal(consumeWakeToken('session-b', token), false);
  // Still consumed (deleted) even though the session didn't match, so it can't be replayed.
  assert.equal(consumeWakeToken('session-a', token), false);
});

test('consumeWakeToken rejects an unknown token', () => {
  assert.equal(consumeWakeToken('session-a', 'not-a-real-token'), false);
});
