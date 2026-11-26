import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ClaudePlanUsage } from '@/shared/types';

/**
 * The newest claude.ai plan usage. It loads the server's last reading once,
 * then follows the `claude_plan_usage_updated` event that every Claude turn
 * sends. It stays null until some turn has reported a reading.
 */
export function useClaudePlanUsage(): ClaudePlanUsage | null {
  const { subscribe } = useWebSocket();
  // The account-wide reading. It is not per session, so no session switch clears it.
  const [planUsage, setPlanUsage] = useState<ClaudePlanUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.providers.claudePlanUsage();
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        // A websocket event that came during the fetch is newer; keep it.
        if (!cancelled && payload?.data) {
          setPlanUsage((current) => current ?? (payload.data as ClaudePlanUsage));
        }
      } catch {
        // No reading yet is the same as no pill.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => subscribe((event) => {
    if (event.type === 'claude_plan_usage_updated' && event.planUsage && typeof event.planUsage === 'object') {
      setPlanUsage(event.planUsage as ClaudePlanUsage);
    }
  }), [subscribe]);

  return planUsage;
}
