import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useChatProviderState } from '../useChatProviderState';
import type { ProjectSession } from '../../../../types/app';

const getPreferences = vi.fn();
const patchPreferences = vi.fn();
const authenticatedFetchMock = vi.fn();

vi.mock('../../../../utils/api', () => ({
  api: {
    user: {
      getPreferences: (...args: unknown[]) => getPreferences(...args),
      patchPreferences: (...args: unknown[]) => patchPreferences(...args),
    },
  },
  authenticatedFetch: (...args: unknown[]) => authenticatedFetchMock(...args),
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

// Deferred promise so tests can control exactly when an active-model fetch
// resolves, to simulate slow/racing backend responses.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useChatProviderState model-selection resolution', () => {
  beforeEach(() => {
    localStorage.clear();
    subscribeListeners.clear();
    getPreferences.mockReset();
    patchPreferences.mockReset();
    authenticatedFetchMock.mockReset();
    getPreferences.mockReturnValue(jsonResponse({ preferences: {} }));
    patchPreferences.mockReturnValue(jsonResponse({ success: true }));

    // Default catch-all: capabilities/provider-models requests the hook also
    // fires on mount. Active-model requests are stubbed per-test below.
    authenticatedFetchMock.mockImplementation((url: string) => {
      if (url.includes('/active-model') && !url.includes('active-model?')) {
        return jsonResponse({ success: true, data: { model: 'default', resolved: false } });
      }
      if (url.includes('/models')) {
        return jsonResponse({ success: false });
      }
      if (url.includes('/capabilities')) {
        return jsonResponse({ success: true, data: { providers: [] } });
      }
      return jsonResponse({ success: false });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('applies the server-stored selected model for a resolved session', async () => {
    getPreferences.mockReturnValue(
      jsonResponse({ preferences: { selectedModel: { sessions: { 'session-1': 'opus' } } } }),
    );

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(result.current.claudeModel).toBe('opus'));
  });

  it('does not persist a guess when the backend reports resolved: false for a brand-new session', async () => {
    getPreferences.mockReturnValue(jsonResponse({ preferences: {} }));
    authenticatedFetchMock.mockImplementation((url: string) => {
      if (url.includes('/active-model')) {
        return jsonResponse({ success: true, data: { model: 'default', resolved: false } });
      }
      return jsonResponse({ success: false });
    });

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    // Shows a sensible default in the meantime...
    await waitFor(() => expect(result.current.claudeModel).toBe('default'));
    // ...without ever PATCHing a preference for the still-unresolved session.
    await new Promise((r) => setTimeout(r, 10));
    expect(patchPreferences).not.toHaveBeenCalled();
  });

  it('applies the backend-resolved model once the active-model lookup confirms it', async () => {
    getPreferences.mockReturnValue(jsonResponse({ preferences: {} }));
    authenticatedFetchMock.mockImplementation((url: string) => {
      if (url.includes('/active-model')) {
        return jsonResponse({ success: true, data: { model: 'sonnet', resolved: true } });
      }
      return jsonResponse({ success: false });
    });

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(result.current.claudeModel).toBe('sonnet'));
    // Resolution from backend evidence is display-only, not an explicit user
    // pick, so it must not be written back as a preference either.
    await new Promise((r) => setTimeout(r, 10));
    expect(patchPreferences).not.toHaveBeenCalled();
  });

  it('rapid session-switching cannot let a stale active-model response pin the wrong model', async () => {
    getPreferences.mockReturnValue(jsonResponse({ preferences: {} }));

    const sessionAFetch = deferred<unknown>();
    const sessionBFetch = deferred<unknown>();

    authenticatedFetchMock.mockImplementation((url: string) => {
      if (url.includes('session-a/active-model')) {
        return sessionAFetch.promise;
      }
      if (url.includes('session-b/active-model')) {
        return sessionBFetch.promise;
      }
      return jsonResponse({ success: false });
    });

    const { result, rerender } = renderHook(
      ({ selectedSession }: { selectedSession: ProjectSession | null }) =>
        useChatProviderState({ selectedSession, selectedProject: null }),
      { initialProps: { selectedSession: makeSession({ id: 'session-a' }) } },
    );

    // Switch to session-b before session-a's lookup has resolved.
    rerender({ selectedSession: makeSession({ id: 'session-b' }) });

    // session-a's slow response arrives *after* the switch — it must be
    // discarded rather than clobbering session-b's display.
    sessionAFetch.resolve(jsonResponse({ success: true, data: { model: 'opus', resolved: true } }));
    await Promise.resolve();
    await Promise.resolve();

    expect(result.current.claudeModel).not.toBe('opus');

    // session-b's own response, once it arrives, is the one that applies.
    sessionBFetch.resolve(jsonResponse({ success: true, data: { model: 'haiku', resolved: true } }));
    await waitFor(() => expect(result.current.claudeModel).toBe('haiku'));
  });

  it('PATCHes the selected-model preference when the user explicitly picks a model', async () => {
    getPreferences.mockReturnValue(jsonResponse({ preferences: {} }));
    authenticatedFetchMock.mockImplementation((url: string, options?: { method?: string }) => {
      if (url.includes('/active-model') && options?.method === 'POST') {
        return jsonResponse({
          success: true,
          data: { supported: true, changed: true, model: 'opus' },
        });
      }
      if (url.includes('/active-model')) {
        return jsonResponse({ success: true, data: { model: 'default', resolved: false } });
      }
      return jsonResponse({ success: false });
    });

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(getPreferences).toHaveBeenCalled());

    await act(async () => {
      await result.current.selectProviderModel('claude', 'opus', 'session-1');
    });

    expect(result.current.claudeModel).toBe('opus');
    await waitFor(() => expect(patchPreferences).toHaveBeenCalledWith({
      selectedModel: { sessions: { 'session-1': 'opus' } },
    }));
  });

  it('applies a preferences_updated broadcast with a malformed array payload without crashing', async () => {
    getPreferences.mockReturnValue(jsonResponse({ preferences: {} }));

    const { result } = renderHook(() =>
      useChatProviderState({ selectedSession: makeSession(), selectedProject: null }),
    );

    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    expect(subscribeListeners.size).toBeGreaterThan(0);

    act(() => {
      for (const listener of subscribeListeners) {
        listener({
          kind: 'preferences_updated',
          preferences: { selectedModel: { sessions: ['a', 'b'] } },
        });
      }
    });

    // Must not crash; falls back to whatever resolution already applied.
    expect(result.current.claudeModel).toBeTruthy();

    act(() => {
      for (const listener of subscribeListeners) {
        listener({
          kind: 'preferences_updated',
          preferences: { selectedModel: { sessions: { 'session-1': 'opus' } } },
        });
      }
    });

    await waitFor(() => expect(result.current.claudeModel).toBe('opus'));
  });
});
