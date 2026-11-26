import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AnyRecord } from '@/shared/types.js';

/** One claude.ai plan window: the share used (0 to 1) and when it resets. */
type PlanUsageWindow = {
  utilization: number;
  /** Epoch milliseconds. */
  resetsAt: number | null;
  status: string | null;
};

type PlanUsageWindowKey = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet';

/**
 * The weekly utilization at the first reading of a ration day. The client
 * measures "used today" against it.
 */
type PlanUsageDayBaseline = {
  /** Epoch ms when this ration day started (see `rationDayStart`). */
  dayStart: number;
  weekUtilization: number;
  /** The weekly window this baseline belongs to; a new window drops it. */
  weekResetsAt: number | null;
};

/** The newest plan usage the CLI reported, as sent to the client. */
type ClaudePlanUsage = {
  windows: Partial<Record<PlanUsageWindowKey, PlanUsageWindow>>;
  /** The representative status: `allowed`, `allowed_warning` or `rejected`. */
  status: string | null;
  overage: {
    status: string | null;
    enabled: boolean | null;
    inUse: boolean | null;
    disabledReason: string | null;
    resetsAt: number | null;
  };
  dayBaseline: PlanUsageDayBaseline | null;
  /** Epoch milliseconds of the event this snapshot came from. */
  updatedAt: number;
};

type ClaudePlanUsageServiceDependencies = {
  now: () => number;
  statePath: string;
  readStateFile: (filePath: string) => string | null;
  writeStateFile: (filePath: string, content: string) => void;
  notify: (usage: ClaudePlanUsage) => void;
};

/** The websocket event type the client listens for. */
const PLAN_USAGE_EVENT_TYPE = 'claude_plan_usage_updated';

// The SDK's `rateLimitType` names, mapped to the keys the client reads.
const RATE_LIMIT_TYPE_TO_WINDOW: Record<string, PlanUsageWindowKey> = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
  seven_day_opus: 'sevenDayOpus',
  seven_day_sonnet: 'sevenDaySonnet',
};

const readNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const readString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const readBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** The CLI sends seconds; a value already in milliseconds is kept. */
const toEpochMs = (value: unknown): number | null => {
  const seconds = readNumber(value);
  if (seconds === null || seconds <= 0) {
    return null;
  }
  return seconds < 1e12 ? seconds * 1000 : seconds;
};

/**
 * `unifiedWindows` sends a fraction (0.52 = 52%). A value over 1 is taken as a
 * percentage, in case a CLI build sends one.
 */
const toFraction = (value: unknown): number | null => {
  const parsed = readNumber(value);
  if (parsed === null || parsed < 0) {
    return null;
  }
  return parsed > 1 ? parsed / 100 : parsed;
};

const readWindow = (raw: unknown): PlanUsageWindow | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as AnyRecord;
  const utilization = toFraction(record.utilization);
  if (utilization === null) {
    return null;
  }
  return {
    utilization,
    resetsAt: toEpochMs(record.resetsAt),
    status: readString(record.status),
  };
};

/**
 * Reads the windows out of one `rate_limit_info`. `unifiedWindows` (not in the
 * SDK types, but sent by the CLI) has every window. Without it, only the one
 * window the top-level fields describe is known.
 */
const readWindows = (info: AnyRecord): Partial<Record<PlanUsageWindowKey, PlanUsageWindow>> => {
  const windows: Partial<Record<PlanUsageWindowKey, PlanUsageWindow>> = {};
  const unified = info.unifiedWindows;
  if (unified && typeof unified === 'object') {
    for (const [rateLimitType, raw] of Object.entries(unified as AnyRecord)) {
      const key = RATE_LIMIT_TYPE_TO_WINDOW[rateLimitType];
      const window = key ? readWindow(raw) : null;
      if (key && window) {
        windows[key] = window;
      }
    }
  }

  const topLevelKey = RATE_LIMIT_TYPE_TO_WINDOW[readString(info.rateLimitType) ?? ''];
  if (topLevelKey && !windows[topLevelKey]) {
    const window = readWindow(info);
    if (window) {
      windows[topLevelKey] = window;
    }
  }
  return windows;
};

const DAY_MS = 86_400_000;

/**
 * Ration days start at the weekly reset's time of day (a week that resets
 * Thursday 03:00 has days from 03:00 to 03:00), so the week is 7 equal days.
 * The client computes the same start. Without a reset time, local midnight.
 */
const rationDayStart = (weekResetsAt: number | null, now: number): number => {
  if (weekResetsAt === null) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime();
  }
  return weekResetsAt - Math.ceil((weekResetsAt - now) / DAY_MS) * DAY_MS;
};

/**
 * Keeps the baseline while the ration day and the weekly window stay the same.
 * On a new day the current reading becomes the baseline. When the weekly window
 * itself rolled over, the week starts from zero, so the baseline is zero.
 */
const nextDayBaseline = (
  previous: PlanUsageDayBaseline | null,
  week: PlanUsageWindow | undefined,
  now: number,
): PlanUsageDayBaseline | null => {
  if (!week) {
    return previous;
  }
  const dayStart = rationDayStart(week.resetsAt, now);
  const sameWeek = previous !== null && previous.weekResetsAt === week.resetsAt;
  if (previous && previous.dayStart === dayStart && sameWeek) {
    return previous;
  }
  return {
    dayStart,
    weekUtilization: previous && !sameWeek ? 0 : week.utilization,
    weekResetsAt: week.resetsAt,
  };
};

const parseStoredUsage = (content: string | null): ClaudePlanUsage | null => {
  if (!content) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as ClaudePlanUsage;
    return parsed && typeof parsed === 'object' && parsed.windows ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Builds the plan usage service. The dependencies are injectable so the tests
 * control time, the state file and the broadcast.
 */
export function createClaudePlanUsageService(dependencies: ClaudePlanUsageServiceDependencies) {
  let current: ClaudePlanUsage | null | undefined;

  // Read lazily, so a server that never runs a Claude turn never touches the file.
  const load = (): ClaudePlanUsage | null => {
    if (current === undefined) {
      current = parseStoredUsage(dependencies.readStateFile(dependencies.statePath));
    }
    return current;
  };

  return {
    /** The newest snapshot, or null before the first turn reports one. */
    getUsage(): ClaudePlanUsage | null {
      return load();
    },

    /**
     * Records one SDK `rate_limit_event`, saves the result and sends it to every
     * connected client. Returns null and changes nothing for a payload with no
     * readable window.
     */
    recordRateLimitInfo(rateLimitInfo: unknown): ClaudePlanUsage | null {
      if (!rateLimitInfo || typeof rateLimitInfo !== 'object') {
        return null;
      }
      const info = rateLimitInfo as AnyRecord;
      const windows = readWindows(info);
      if (Object.keys(windows).length === 0) {
        return null;
      }

      const previous = load();
      const now = dependencies.now();
      // An event without `unifiedWindows` names one window; keep the others.
      const mergedWindows = { ...(previous?.windows ?? {}), ...windows };
      const next: ClaudePlanUsage = {
        windows: mergedWindows,
        status: readString(info.status),
        overage: {
          status: readString(info.overageStatus),
          enabled: readBoolean(info.overageEnabled),
          inUse: readBoolean(info.isUsingOverage) ?? readBoolean(info.overageInUse),
          disabledReason: readString(info.overageDisabledReason),
          resetsAt: toEpochMs(info.overageResetsAt),
        },
        dayBaseline: nextDayBaseline(previous?.dayBaseline ?? null, mergedWindows.sevenDay, now),
        updatedAt: now,
      };
      current = next;

      try {
        dependencies.writeStateFile(dependencies.statePath, JSON.stringify(next));
      } catch (error) {
        // A failed save costs only the baseline after a restart; the live view still works.
        console.warn('[plan-usage] Could not save plan usage:', error);
      }
      dependencies.notify(next);
      return next;
    },
  };
}

// The state file sits beside auth.db, in `~/.cloudcli` by default.
const defaultStatePath = () => path.join(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : path.join(os.homedir(), '.cloudcli'),
  'claude-plan-usage.json',
);

/**
 * Used by the Claude runtime provider to record each turn's `rate_limit_event`,
 * and by the provider routes to serve the newest snapshot on page load.
 */
export const claudePlanUsageService = createClaudePlanUsageService({
  now: () => Date.now(),
  statePath: defaultStatePath(),
  readStateFile: (filePath) => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  },
  writeStateFile: (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  },
  notify: (usage) => {
    // Loaded on first use: the websocket barrel reaches the Claude runtime,
    // which imports this file, so a static import is a circular import.
    void import('@/modules/websocket/index.js')
      .then(({ broadcastToConnectedClients }) => {
        broadcastToConnectedClients(JSON.stringify({ type: PLAN_USAGE_EVENT_TYPE, planUsage: usage }));
      })
      .catch((error: unknown) => {
        console.warn('[plan-usage] Could not send plan usage:', error);
      });
  },
});
