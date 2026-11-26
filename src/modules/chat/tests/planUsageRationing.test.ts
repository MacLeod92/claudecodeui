import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { computeWeeklyRation, currentUtilization } from '@/modules/chat/utils/planUsageRationing';
import type { ClaudePlanUsage } from '@/shared/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Local noon, so "today" is clear of midnight.
const NOW = new Date(2026, 10, 26, 12, 0).getTime();
// The start of the ration day that holds NOW, for a week that resets at `resetsAt`.
const dayStartFor = (resetsAt: number) => resetsAt - Math.ceil((resetsAt - NOW) / DAY) * DAY;

const usageWith = (
  weekUtilization: number,
  weekResetsAt: number,
  dayBaseline: ClaudePlanUsage['dayBaseline'],
): ClaudePlanUsage => ({
  windows: {
    fiveHour: { utilization: 0.4, resetsAt: NOW + 2 * HOUR, status: 'allowed' },
    sevenDay: { utilization: weekUtilization, resetsAt: weekResetsAt, status: 'allowed' },
  },
  status: 'allowed',
  overage: { status: null, enabled: null, inUse: null, disabledReason: null, resetsAt: null },
  dayBaseline,
  updatedAt: NOW,
});

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

describe('computeWeeklyRation', () => {
  it('splits the remaining week equally over the days left', () => {
    // 4 days left from now, 60% left: 15% per day.
    const resetsAt = NOW + 4 * DAY;
    const ration = computeWeeklyRation(usageWith(0.4, resetsAt, null), NOW);
    assert.ok(ration);
    close(ration.weekRemaining, 0.6);
    close(ration.daysLeft, 4);
    close(ration.perDay, 0.15);
  });

  it('measures today against the first reading of the day', () => {
    // The week resets in 3.5 days, so today is the first of 4 ration days.
    const resetsAt = NOW + 3.5 * DAY;
    const ration = computeWeeklyRation(
      usageWith(0.4, resetsAt, { dayStart: dayStartFor(resetsAt), weekUtilization: 0.31, weekResetsAt: resetsAt }),
      NOW,
    );
    assert.ok(ration);
    close(ration.todayAllowance, 0.69 / 4);
    close(ration.usedToday, 0.09);
    close(ration.leftToday, 0.69 / 4 - 0.09);
  });

  it('shows a negative left-today when today is over its share', () => {
    const resetsAt = NOW + 2 * DAY;
    const ration = computeWeeklyRation(
      usageWith(0.9, resetsAt, { dayStart: dayStartFor(resetsAt), weekUtilization: 0.5, weekResetsAt: resetsAt }),
      NOW,
    );
    assert.ok(ration && ration.leftToday < 0);
  });

  it('counts nothing used today when the baseline is from another day or week', () => {
    const resetsAt = NOW + 3 * DAY;
    const stale = computeWeeklyRation(
      usageWith(0.5, resetsAt, { dayStart: dayStartFor(resetsAt) - DAY, weekUtilization: 0.2, weekResetsAt: resetsAt }),
      NOW,
    );
    assert.equal(stale?.usedToday, 0);
    const otherWeek = computeWeeklyRation(
      usageWith(0.5, resetsAt, { dayStart: dayStartFor(resetsAt), weekUtilization: 0.2, weekResetsAt: resetsAt - 7 * DAY }),
      NOW,
    );
    assert.equal(otherWeek?.usedToday, 0);
  });

  it('starts each ration day at the weekly reset time of day, not at midnight', () => {
    // The week resets Thu 3 Dec 03:00. At 02:00 on 27 Nov, today began 26 Nov 03:00.
    const resetsAt = new Date(2026, 11, 3, 3, 0).getTime();
    const twoAm = new Date(2026, 10, 27, 2, 0).getTime();
    const ration = computeWeeklyRation(usageWith(0.2, resetsAt, null), twoAm);
    assert.equal(ration?.todayEndsAt, new Date(2026, 10, 27, 3, 0).getTime());
    // 7 ration days are left, today included: 26 Nov 03:00 up to 3 Dec 03:00.
    close(ration?.todayAllowance ?? 0, 0.8 / 7);
  });

  it('gives the whole remainder to the last day', () => {
    const ration = computeWeeklyRation(usageWith(0.7, NOW + 6 * HOUR, null), NOW);
    close(ration?.perDay ?? 0, 0.3);
  });

  it('returns null with no weekly window or one that has reset', () => {
    assert.equal(computeWeeklyRation(null, NOW), null);
    assert.equal(computeWeeklyRation(usageWith(0.5, NOW - HOUR, null), NOW), null);
  });
});

describe('currentUtilization', () => {
  it('reads zero for a window whose reset time has passed', () => {
    assert.equal(currentUtilization({ utilization: 0.8, resetsAt: NOW - 1, status: null }, NOW), 0);
    assert.equal(currentUtilization({ utilization: 0.8, resetsAt: NOW + 1, status: null }, NOW), 0.8);
    assert.equal(currentUtilization(undefined, NOW), null);
  });
});
