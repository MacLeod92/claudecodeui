import type { ClaudePlanUsage, ClaudePlanUsageWindow } from '@/shared/types';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** How the rest of the weekly window divides into equal days. All shares are 0 to 1 of the week. */
export type WeeklyRation = {
  weekUsed: number;
  weekRemaining: number;
  /** Fractional days until the weekly window resets. */
  daysLeft: number;
  /** The remaining share divided by the days left, from now. */
  perDay: number;
  /** Today's equal share, fixed at the first reading of the day. */
  todayAllowance: number;
  usedToday: number;
  /** Today's allowance less today's use. Negative when today is over its share. */
  leftToday: number;
};

const localDateKey = (epochMs: number): string => {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

const startOfLocalDay = (epochMs: number): number => {
  const date = new Date(epochMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/**
 * A window whose reset time has passed is a new, empty window, so its old
 * utilization no longer applies. Used by the pill and the modal.
 */
export function currentUtilization(window: ClaudePlanUsageWindow | undefined, now: number): number | null {
  if (!window) {
    return null;
  }
  if (window.resetsAt !== null && window.resetsAt <= now) {
    return 0;
  }
  return window.utilization;
}

/**
 * Divides the rest of the weekly window into equal days.
 *
 * - `perDay` = remaining / days left. With less than one day left, the whole
 *   remaining share is today's.
 * - `todayAllowance` uses the first reading of today, so it does not shrink
 *   while you work: (1 - baseline) / days left at the start of today. With no
 *   reading today yet, nothing is used today, so the baseline is the current
 *   reading.
 *
 * Returns null when no weekly window is known or it has already reset.
 */
export function computeWeeklyRation(usage: ClaudePlanUsage | null, now: number): WeeklyRation | null {
  const week = usage?.windows.sevenDay;
  if (!week || week.resetsAt === null || week.resetsAt <= now) {
    return null;
  }

  const weekUsed = Math.min(1, week.utilization);
  const weekRemaining = Math.max(0, 1 - weekUsed);
  const daysLeft = (week.resetsAt - now) / DAY_MS;
  const perDay = weekRemaining / Math.max(daysLeft, 1);

  const baseline = usage?.dayBaseline;
  const baselineIsToday = Boolean(
    baseline
    && baseline.date === localDateKey(now)
    && baseline.weekResetsAt === week.resetsAt,
  );
  const todayBaseline = baseline && baselineIsToday ? Math.min(baseline.weekUtilization, weekUsed) : weekUsed;

  // Today starts at local midnight, or at the window start if the week began today.
  const todayStart = Math.max(startOfLocalDay(now), week.resetsAt - WEEK_MS);
  const daysLeftAtTodayStart = (week.resetsAt - todayStart) / DAY_MS;
  const todayAllowance = Math.max(0, 1 - todayBaseline) / Math.max(daysLeftAtTodayStart, 1);
  const usedToday = weekUsed - todayBaseline;

  return {
    weekUsed,
    weekRemaining,
    daysLeft,
    perDay,
    todayAllowance,
    usedToday,
    leftToday: todayAllowance - usedToday,
  };
}
