import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudePlanUsageService } from '@/modules/providers/services/claude-plan-usage.service.js';

const HOUR = 3_600_000;

const createHarness = (stored: string | null = null) => {
  let now = new Date(2026, 10, 26, 9, 0).getTime();
  const files = new Map<string, string>();
  if (stored) {
    files.set('/state.json', stored);
  }
  const notified: unknown[] = [];
  const service = createClaudePlanUsageService({
    now: () => now,
    statePath: '/state.json',
    readStateFile: (filePath) => files.get(filePath) ?? null,
    writeStateFile: (filePath, content) => {
      files.set(filePath, content);
    },
    notify: (usage) => {
      notified.push(usage);
    },
  });
  return {
    service,
    files,
    notified,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

// The shape a real CLI turn sent (SDK 0.3.311).
const realEvent = (fiveHour = 0.52, sevenDay = 0.07, weekResetsAt = 1796266800) => ({
  status: 'allowed',
  resetsAt: 1795696200,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled_until',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: fiveHour, resetsAt: 1795696200, status: 'allowed' },
    seven_day: { utilization: sevenDay, resetsAt: weekResetsAt, status: 'allowed' },
  },
});

test('reads both windows from unifiedWindows, in fractions and milliseconds', () => {
  const { service, notified, files } = createHarness();
  const usage = service.recordRateLimitInfo(realEvent());

  assert.ok(usage);
  assert.deepEqual(usage.windows.fiveHour, { utilization: 0.52, resetsAt: 1795696200_000, status: 'allowed' });
  assert.equal(usage.windows.sevenDay?.utilization, 0.07);
  assert.equal(usage.overage.status, 'rejected');
  assert.equal(usage.overage.disabledReason, 'org_level_disabled_until');
  assert.equal(usage.overage.inUse, false);
  assert.equal(notified.length, 1);
  assert.ok(files.get('/state.json'));
});

test('without unifiedWindows, the top-level window is kept and merged with known ones', () => {
  const { service } = createHarness();
  service.recordRateLimitInfo(realEvent());
  const usage = service.recordRateLimitInfo({
    status: 'allowed_warning',
    rateLimitType: 'seven_day',
    utilization: 0.81,
    resetsAt: 1796266800,
  });

  assert.equal(usage?.windows.sevenDay?.utilization, 0.81);
  assert.equal(usage?.windows.fiveHour?.utilization, 0.52);
  assert.equal(usage?.status, 'allowed_warning');
});

test('a payload with no readable window changes nothing', () => {
  const { service, notified } = createHarness();
  assert.equal(service.recordRateLimitInfo({ status: 'allowed' }), null);
  assert.equal(service.recordRateLimitInfo(null), null);
  assert.equal(service.getUsage(), null);
  assert.equal(notified.length, 0);
});

test('the day baseline stays for the day and moves on the next day', () => {
  const { service, advance } = createHarness();
  service.recordRateLimitInfo(realEvent(0.1, 0.2));
  advance(2 * HOUR);
  const sameDay = service.recordRateLimitInfo(realEvent(0.3, 0.25));
  assert.equal(sameDay?.dayBaseline?.weekUtilization, 0.2);

  advance(24 * HOUR);
  const nextDay = service.recordRateLimitInfo(realEvent(0.05, 0.3));
  assert.equal(nextDay?.dayBaseline?.weekUtilization, 0.3);
  assert.notEqual(nextDay?.dayBaseline?.date, sameDay?.dayBaseline?.date);
});

test('a new weekly window starts the baseline from zero', () => {
  const { service, advance } = createHarness();
  service.recordRateLimitInfo(realEvent(0.1, 0.9));
  advance(HOUR);
  const usage = service.recordRateLimitInfo(realEvent(0.1, 0.02, 1796871600));
  assert.equal(usage?.dayBaseline?.weekUtilization, 0);
});

test('the saved snapshot is served after a restart', () => {
  const first = createHarness();
  first.service.recordRateLimitInfo(realEvent());
  const restarted = createHarness(first.files.get('/state.json'));
  assert.equal(restarted.service.getUsage()?.windows.fiveHour?.utilization, 0.52);
});
