import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useChatProviderState } from '../useChatProviderState';
import type { ProjectSession } from '../../../../types/app';

const getPreferences = vi.fn();
const patchPreferences = vi.fn();

vi.mock('../../../../utils/api', () => ({
  api: {
    user: {
      getPreferences: (...args: unknown[]) => getPreferences(...args),
      patchPreferences: (...args: unknown[]) => patchPreferences(...args),
    },
  },
  authenticatedFetch: vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ success: true, data: { providers: [] } }),
    }),
  ),
}));

const subscribeListeners = new Set<(event: unknown) => void>();
vi.mock('../../../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({
    subscribe: (listener: (event: unknown) => void) => {
      subscribeListeners.add(listener);
      return () => subscribeListeners.delete(listener);
    },
  }),
}));

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body });
}

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return { id: 'session-1', __provider: 'claude', ...overrides };
}

describe('useChatProviderState permission mode resolution', () => {
  beforeEach(() => {
    localStorage.clear();
    subscribeListeners.clear();
    getPreferences.mockReset();
    patchPreferences.mockReset();
    getPreferences.mockReturnValue(jsonResponse({ preferences: {} }));
    patchPreferences.mockReturnValue(jsonResponse({ success: true }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('falls through to the provider default when nothing is stored', async () => {
    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
  });

  it('resolves to the session\'s own stored mode when it is valid for the provider', async () => {
    getPreferences.mockReturnValue(
      jsonResponse({ preferences: { permissionMode: { sessions: { 'session-1': 'acceptEdits' } } } }),
    );

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(result.current.permissionMode).toBe('acceptEdits'));
  });

  it('rejects a stored mode that is invalid for the current provider and falls back to default', async () => {
    // 'auto' is claude-only; a session belonging to a non-claude provider
    // with a stale/foreign 'auto' entry must not resolve to it.
    getPreferences.mockReturnValue(
      jsonResponse({ preferences: { permissionMode: { sessions: { 'session-1': 'auto' } } } }),
    );

    const { result } = renderHook(() =>
      useChatProviderState({
        selectedSession: makeSession({ __provider: 'codex' }),
        selectedProject: null,
      }),
    );

    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
    expect(result.current.permissionMode).not.toBe('auto');
  });

  it('treats a malformed array sessions payload as empty instead of crashing or misresolving', async () => {
    getPreferences.mockReturnValue(
      jsonResponse({ preferences: { permissionMode: { sessions: ['a', 'b'] } } }),
    );

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
  });

  it('re-fetches from the server on reconnect instead of trusting the stale cache', async () => {
    getPreferences.mockReturnValueOnce(
      jsonResponse({ preferences: { permissionMode: { sessions: { 'session-1': 'acceptEdits' } } } }),
    );

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(result.current.permissionMode).toBe('acceptEdits'));
    expect(getPreferences).toHaveBeenCalledTimes(1);

    getPreferences.mockReturnValueOnce(
      jsonResponse({ preferences: { permissionMode: { sessions: { 'session-1': 'bypassPermissions' } } } }),
    );

    await act(async () => {
      await result.current.refreshPermissionModeFromServer();
    });

    expect(getPreferences).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.permissionMode).toBe('bypassPermissions'));
  });

  it('rolls back the optimistic mode change and flags the failure when the PATCH rejects', async () => {
    getPreferences.mockReturnValue(
      jsonResponse({ preferences: { permissionMode: { sessions: { 'session-1': 'default' } } } }),
    );
    patchPreferences.mockImplementation(() => Promise.reject(new Error('simulated 500')));

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
    expect(result.current.permissionModeSyncFailed).toBe(false);

    act(() => {
      result.current.cyclePermissionMode();
    });

    // Optimistic update applies immediately (claude's mode order is
    // default -> auto -> acceptEdits -> bypassPermissions -> plan)...
    expect(result.current.permissionMode).toBe('auto');

    // ...then rolls back once the PATCH rejects, with the failure surfaced
    // rather than silent (see permissionModeSyncFailed).
    await waitFor(() => expect(patchPreferences).toHaveBeenCalled());
    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
    await waitFor(() => expect(result.current.permissionModeSyncFailed).toBe(true));
    expect(localStorage.getItem('permissionMode-session-1')).toBe('default');
  });

  it('rolls back and flags the failure when the PATCH resolves with a non-2xx response', async () => {
    // authenticatedFetch resolves (not rejects) on HTTP-level failures like
    // 403/500 — only network-level failures reject. This exercises that
    // resolved-but-not-ok path, distinct from the rejected-promise case above.
    getPreferences.mockReturnValue(
      jsonResponse({ preferences: { permissionMode: { sessions: { 'session-1': 'default' } } } }),
    );
    patchPreferences.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 403, json: async () => ({ success: false }) }),
    );

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
    expect(result.current.permissionModeSyncFailed).toBe(false);

    act(() => {
      result.current.cyclePermissionMode();
    });

    expect(result.current.permissionMode).toBe('auto');

    await waitFor(() => expect(patchPreferences).toHaveBeenCalled());
    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
    await waitFor(() => expect(result.current.permissionModeSyncFailed).toBe(true));
    expect(localStorage.getItem('permissionMode-session-1')).toBe('default');
  });

  it('applies a preferences_updated broadcast with a malformed array payload without crashing', async () => {
    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
    expect(subscribeListeners.size).toBeGreaterThan(0);

    act(() => {
      for (const listener of subscribeListeners) {
        listener({
          kind: 'preferences_updated',
          preferences: { permissionMode: { sessions: ['a', 'b'] } },
        });
      }
    });

    // A malformed broadcast must not crash the listener or resolve to a
    // bogus mode picked up from array indices.
    expect(result.current.permissionMode).toBe('default');

    act(() => {
      for (const listener of subscribeListeners) {
        listener({
          kind: 'preferences_updated',
          preferences: { permissionMode: { sessions: { 'session-1': 'bypassPermissions' } } },
        });
      }
    });

    await waitFor(() => expect(result.current.permissionMode).toBe('bypassPermissions'));
  });
});
