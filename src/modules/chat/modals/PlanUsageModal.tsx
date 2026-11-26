import { useTranslation } from 'react-i18next';
import { Gauge, X } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { ClaudePlanUsage, ClaudePlanUsageWindow } from '@/shared/types';
import { computeWeeklyRation, currentUtilization } from '@/modules/chat/utils/planUsageRationing';

type PlanUsageModalProps = {
  usage: ClaudePlanUsage;
  /** The pill's minute clock; all times here are measured against it. */
  now: number;
  isOpen: boolean;
  onClose: () => void;
};

const formatPercent = (share: number) => {
  const percent = share * 100;
  return `${Math.abs(percent) < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
};

const formatResetTime = (epochMs: number, now: number) => {
  const date = new Date(epochMs);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Within a day the time is enough; further out, the weekday tells which day.
  if (epochMs - now < 86_400_000 && date.getDate() === new Date(now).getDate()) {
    return time;
  }
  return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
};

const barColor = (utilization: number, status: string | null) => {
  if (status === 'rejected' || utilization >= 0.95) return 'bg-red-500';
  if (status === 'allowed_warning' || utilization >= 0.8) return 'bg-amber-500';
  return 'bg-primary';
};

type WindowRowProps = {
  label: string;
  window: ClaudePlanUsageWindow;
  now: number;
};

function WindowRow({ label, window, now }: WindowRowProps) {
  const { t } = useTranslation();
  const utilization = currentUtilization(window, now) ?? 0;
  const resetsAt = window.resetsAt !== null && window.resetsAt > now ? window.resetsAt : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{formatPercent(utilization)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${barColor(utilization, window.status)}`}
          style={{ width: `${Math.min(100, utilization * 100)}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground">
        {resetsAt
          ? t('chat:planUsage.resetsAt', { time: formatResetTime(resetsAt, now) })
          : t('chat:planUsage.resetSinceReading')}
      </div>
    </div>
  );
}

/**
 * Opened by chat's PlanUsagePill. It shows each claude.ai plan window and
 * divides the rest of the week into equal daily shares.
 */
export default function PlanUsageModal({ usage, now, isOpen, onClose }: PlanUsageModalProps) {
  const { t } = useTranslation();
  if (!isOpen) {
    return null;
  }

  const { fiveHour, sevenDay, sevenDayOpus, sevenDaySonnet } = usage.windows;
  const ration = computeWeeklyRation(usage, now);
  const overToday = ration !== null && ration.leftToday < 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md overflow-hidden rounded-3xl border-border/80 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl">
        <DialogTitle>{t('chat:planUsage.title')}</DialogTitle>

        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted text-foreground">
              <Gauge className="h-5 w-5" />
            </div>
            <div>
              <div className="text-base font-semibold text-foreground">{t('chat:planUsage.title')}</div>
              <div className="text-xs text-muted-foreground">
                {t('chat:planUsage.updatedAt', {
                  time: new Date(usage.updatedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
                })}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t('chat:planUsage.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70dvh] space-y-5 overflow-y-auto px-5 py-5">
          {fiveHour && <WindowRow label={t('chat:planUsage.fiveHour')} window={fiveHour} now={now} />}
          {sevenDay && <WindowRow label={t('chat:planUsage.sevenDay')} window={sevenDay} now={now} />}
          {sevenDayOpus && <WindowRow label={t('chat:planUsage.sevenDayOpus')} window={sevenDayOpus} now={now} />}
          {sevenDaySonnet && <WindowRow label={t('chat:planUsage.sevenDaySonnet')} window={sevenDaySonnet} now={now} />}

          {ration && (
            <div className="space-y-3 rounded-2xl border border-border bg-muted/40 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-sm font-semibold text-foreground">{t('chat:planUsage.rationTitle')}</div>
                <div className="text-xs text-muted-foreground">
                  {t('chat:planUsage.dayEndsAt', { time: formatResetTime(ration.todayEndsAt, now) })}
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('chat:planUsage.todayAllowance')}</dt>
                <dd className="text-right tabular-nums text-foreground">{formatPercent(ration.todayAllowance)}</dd>
                <dt className="text-muted-foreground">{t('chat:planUsage.usedToday')}</dt>
                <dd className="text-right tabular-nums text-foreground">{formatPercent(ration.usedToday)}</dd>
                <dt className="text-muted-foreground">
                  {overToday ? t('chat:planUsage.overToday') : t('chat:planUsage.leftToday')}
                </dt>
                <dd className={`text-right font-medium tabular-nums ${overToday ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
                  {formatPercent(Math.abs(ration.leftToday))}
                </dd>
              </dl>
              <p className="text-xs text-muted-foreground">
                {t('chat:planUsage.rationFromNow', {
                  perDay: formatPercent(ration.perDay),
                  days: ration.daysLeft.toFixed(1),
                })}
              </p>
              <p className="text-xs text-muted-foreground/80">{t('chat:planUsage.rationNote')}</p>
            </div>
          )}

          {usage.overage.status && (
            <div className="text-xs text-muted-foreground">
              {t('chat:planUsage.overage', {
                status: usage.overage.inUse ? t('chat:planUsage.overageInUse') : usage.overage.status,
              })}
              {usage.overage.disabledReason ? ` (${usage.overage.disabledReason})` : ''}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
