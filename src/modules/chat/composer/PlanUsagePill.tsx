import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useClaudePlanUsage } from '@/modules/chat/hooks/useClaudePlanUsage';
import PlanUsageModal from '@/modules/chat/modals/PlanUsageModal';
import { currentUtilization } from '@/modules/chat/utils/planUsageRationing';

const formatClockTime = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const toneClassName = (status: string | null, utilization: number) => {
  if (status === 'rejected' || utilization >= 0.95) {
    return 'border-red-500/40 text-red-600 dark:text-red-400';
  }
  if (status === 'allowed_warning' || utilization >= 0.8) {
    return 'border-amber-500/40 text-amber-600 dark:text-amber-400';
  }
  return 'border-border/70 text-foreground';
};

/**
 * Rendered by chat's ChatComposer beside the token count for Claude sessions.
 * It shows the five-hour window's use and reset time, and opens the plan
 * usage modal on click. It renders nothing until a turn reports a reading.
 */
function PlanUsagePill() {
  const { t } = useTranslation();
  const planUsage = useClaudePlanUsage();
  // The pill owns its modal, so the composer needs no extra props for it.
  const [isModalOpen, setIsModalOpen] = useState(false);
  // A minute clock, so a passed reset time shows as a new window without a new turn.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const fiveHour = planUsage?.windows.fiveHour;
  const utilization = currentUtilization(fiveHour, now);
  if (!planUsage || !fiveHour || utilization === null) {
    return null;
  }

  const percent = Math.round(utilization * 100);
  // A passed reset time belongs to the old window, so it is not shown.
  const resetsAt = fiveHour.resetsAt !== null && fiveHour.resetsAt > now ? fiveHour.resetsAt : null;
  const label = resetsAt
    ? t('chat:planUsage.pillTitle', { percent, time: formatClockTime(resetsAt) })
    : t('chat:planUsage.pillTitleNoReset', { percent });

  return (
    <>
      <button
        type="button"
        onClick={() => setIsModalOpen(true)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background/70 px-2 text-xs shadow-sm transition-colors hover:border-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-2.5 ${toneClassName(fiveHour.status, utilization)}`}
        title={label}
        aria-label={label}
      >
        <span className="font-medium">{percent}%</span>
        {resetsAt && <span className="text-muted-foreground">{formatClockTime(resetsAt)}</span>}
      </button>
      <PlanUsageModal usage={planUsage} now={now} isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and the reading changes once per turn. */
export default memo(PlanUsagePill);
