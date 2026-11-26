import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import PlanUsagePill from '@/modules/chat/composer/PlanUsagePill';
import type { ClaudePlanUsage, ServerEvent } from '@/shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const listeners = new Set<(event: ServerEvent) => void>();
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }),
}));

const claudePlanUsage = vi.fn();
vi.mock('@/shared/api', () => ({
  api: { providers: { claudePlanUsage: () => claudePlanUsage() } },
}));

const reading = (fiveHour: number, resetsAt: number): ClaudePlanUsage => ({
  windows: {
    fiveHour: { utilization: fiveHour, resetsAt, status: 'allowed' },
    sevenDay: { utilization: 0.07, resetsAt: Date.now() + 5 * 86_400_000, status: 'allowed' },
  },
  status: 'allowed',
  overage: { status: 'rejected', enabled: null, inUse: false, disabledReason: null, resetsAt: null },
  dayBaseline: null,
  updatedAt: Date.now(),
});

afterEach(() => {
  listeners.clear();
  claudePlanUsage.mockReset();
});

describe('PlanUsagePill', () => {
  it('renders nothing before any turn reports a reading', async () => {
    claudePlanUsage.mockResolvedValue({ ok: true, json: async () => ({ data: null }) });
    const { container } = render(<PlanUsagePill />);
    await act(async () => {});
    assert.equal(container.textContent, '');
  });

  it('shows the percentage and the reset time from the websocket event, then opens the modal', async () => {
    claudePlanUsage.mockResolvedValue({ ok: true, json: async () => ({ data: null }) });
    const { getByRole, findByText } = render(<PlanUsagePill />);
    await act(async () => {});

    const resetsAt = Date.now() + 2 * 3_600_000;
    act(() => {
      listeners.forEach((listener) => listener({ type: 'claude_plan_usage_updated', planUsage: reading(0.52, resetsAt) }));
    });

    const time = new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const button = getByRole('button');
    assert.equal(button.textContent, `52%${time}`);

    fireEvent.click(button);
    await findByText('chat:planUsage.rationTitle');
  });
});
