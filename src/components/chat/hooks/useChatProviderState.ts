import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { api, authenticatedFetch } from '../../../utils/api';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type {
  ProjectSession,
  LLMProvider,
  Project,
  ProviderModelOption,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
} from '../../../types/app';
import {
  DEFAULT_EFFORT_VALUE,
  FALLBACK_PROVIDER_EFFORT_VALUES,
  toProviderEffortOptions,
} from '../constants/providerEffort';

const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  cursor: 'gpt-5.3-codex',
  codex: 'gpt-5.4',
  opencode: 'anthropic/claude-sonnet-4-5',
};

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

const readStoredProvider = (): LLMProvider => {
  const storedProvider = localStorage.getItem('selected-provider');
  return PROVIDERS.includes(storedProvider as LLMProvider)
    ? storedProvider as LLMProvider
    : 'claude';
};

/**
 * Fallback permission-mode matrix used only until the backend capability
 * matrix (`GET /api/providers/capabilities`) has loaded. The backend is the
 * source of truth; this mirror exists so the composer renders sensibly on
 * first paint and when the capabilities request fails.
 */
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  cursor: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};

/**
 * Server-synced shape of the `permissionMode` key inside the generic
 * `/api/user/preferences` blob. Keyed by session id only — a session's mode
 * is never inherited from another session, so there is no per-provider
 * "last picked anywhere" fallback (see [[permission_mode_bleed]] for why
 * that used to exist and why it was removed).
 */
type StoredPermissionModePreferences = {
  sessions: Record<string, string>;
};

type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsTokenUsage: boolean;
  supportsEffort?: boolean;
};

type ProviderCapabilitiesApiResponse = {
  success?: boolean;
  data?: {
    providers?: ProviderCapabilities[];
  };
};

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
}

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
    cache?: ProviderModelsCacheInfo;
  };
};

type ChangeActiveModelApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string;
    supported?: boolean;
    changed?: boolean;
    model?: string | null;
  };
};

export function useChatProviderState({ selectedSession, selectedProject: _selectedProject }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<LLMProvider>(readStoredProvider);
  const [cursorModel, setCursorModel] = useState<string>(() => {
    return localStorage.getItem('cursor-model') || FALLBACK_DEFAULT_MODEL.cursor;
  });
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return localStorage.getItem('claude-model') || FALLBACK_DEFAULT_MODEL.claude;
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return localStorage.getItem('codex-model') || FALLBACK_DEFAULT_MODEL.codex;
  });
  const [providerEfforts, setProviderEfforts] = useState<Partial<Record<LLMProvider, string>>>(() => {
    return PROVIDERS.reduce<Partial<Record<LLMProvider, string>>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(`${targetProvider}-effort`) || DEFAULT_EFFORT_VALUE;
      return acc;
    }, {});
  });
  const [opencodeModel, setOpenCodeModel] = useState<string>(() => {
    return localStorage.getItem('opencode-model') || FALLBACK_DEFAULT_MODEL.opencode;
  });

  /**
   * Backend-owned capability matrix keyed by provider. Drives the permission
   * mode picker (and is the extension point for future per-provider UI
   * differences) so the frontend stays free of hardcoded provider branching.
   * Null until `/api/providers/capabilities` resolves; the static fallback
   * map covers that window.
   */
  const [providerCapabilities, setProviderCapabilities] = useState<
    Partial<Record<LLMProvider, ProviderCapabilities>> | null
  >(null);

  /**
   * Null until `GET /api/user/preferences` resolves (success or failure).
   * Once resolved, this is treated as authoritative over localStorage for
   * permission mode restoration; localStorage remains the instant-paint
   * fallback while the request is in flight or if it fails.
   */
  const [serverPermissionModes, setServerPermissionModes] = useState<StoredPermissionModePreferences | null>(null);
  const preferencesResolvedRef = useRef(false);

  // Holds the mode picked while a brand-new chat has no session id yet, so
  // it can be carried forward the moment the real id is assigned (which
  // happens right after the first send). This is intentionally in-memory
  // and single-use rather than a persisted per-provider "last picked
  // anywhere" value — persisting it let a mode change on any session bleed
  // into every subsequently created session. See [[permission_mode_bleed]].
  const pendingCarryoverModeRef = useRef<PermissionMode | null>(null);
  const hadSessionIdRef = useRef(Boolean(selectedSession?.id));

  // Shared by the mount-time load and the reconnect refresh below, so both
  // parse the response the same way instead of drifting.
  const fetchPermissionModePreferences = useCallback(async (): Promise<StoredPermissionModePreferences> => {
    const response = await api.user.getPreferences();
    const body = await response.json();
    const stored = body?.preferences?.permissionMode;
    return {
      sessions: (stored && typeof stored.sessions === 'object' && stored.sessions) || {},
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadPreferences = async () => {
      try {
        const fresh = await fetchPermissionModePreferences();
        if (cancelled) {
          return;
        }

        setServerPermissionModes(fresh);
      } catch (error) {
        console.error('Error loading user preferences:', error);
      } finally {
        if (!cancelled) {
          preferencesResolvedRef.current = true;
        }
      }
    };

    void loadPreferences();
    return () => {
      cancelled = true;
    };
  }, [fetchPermissionModePreferences]);

  const { subscribe } = useWebSocket();

  // Live cross-device sync: another device/tab PATCHing its own preferences
  // triggers a `preferences_updated` broadcast (scoped to this user, see
  // `broadcastToUser` in websocket-state.service.ts) that we fold into the
  // same state the restore effect below already treats as authoritative —
  // no separate merge logic needed, the existing per-session/per-provider
  // resolution just re-runs against the fresher data.
  useEffect(() => {
    return subscribe((event) => {
      if (event.kind !== 'preferences_updated') {
        return;
      }

      const stored = (event as { preferences?: { permissionMode?: unknown } }).preferences?.permissionMode as
        | { sessions?: unknown }
        | undefined;
      if (!stored) {
        return;
      }

      setServerPermissionModes({
        sessions: (stored.sessions && typeof stored.sessions === 'object' ? stored.sessions : {}) as Record<string, string>,
      });
      preferencesResolvedRef.current = true;
    });
  }, [subscribe]);

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelCacheCatalog, setProviderModelCacheCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsCacheInfo>>
  >({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);
  const [providerModelsRefreshing, setProviderModelsRefreshing] = useState(false);

  const providerModelsRequestIdRef = useRef(0);

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
    if (targetProvider === 'claude') {
      setClaudeModel(model);
      localStorage.setItem('claude-model', model);
      return;
    }

    if (targetProvider === 'cursor') {
      setCursorModel(model);
      localStorage.setItem('cursor-model', model);
      return;
    }

    if (targetProvider === 'codex') {
      setCodexModel(model);
      localStorage.setItem('codex-model', model);
      return;
    }

    setOpenCodeModel(model);
    localStorage.setItem('opencode-model', model);
  }, []);

  const setStoredProviderEffort = useCallback((targetProvider: LLMProvider, effort: string) => {
    setProviderEfforts((previous) => (
      previous[targetProvider] === effort
        ? previous
        : { ...previous, [targetProvider]: effort }
    ));
    localStorage.setItem(`${targetProvider}-effort`, effort);
  }, []);

  const loadProviderModels = useCallback(async (options: { bypassCache?: boolean } = {}) => {
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    const isHardRefresh = options.bypassCache === true;

    if (isHardRefresh) {
      setProviderModelsRefreshing(true);
    } else {
      setProviderModelsLoading(true);
    }

    try {
      const results = await Promise.all(
        PROVIDERS.map(async (p) => {
          const params = new URLSearchParams();
          if (options.bypassCache) {
            params.set('bypassCache', 'true');
          }

          const queryString = params.toString();
          const response = await authenticatedFetch(`/api/providers/${p}/models${queryString ? `?${queryString}` : ''}`);
          const body = (await response.json()) as ProviderModelsApiResponse;
          if (!body.success || !body.data?.models || !body.data?.cache) {
            return null;
          }

          return body.data;
        }),
      );

      if (providerModelsRequestIdRef.current !== requestId) {
        return;
      }

      const nextCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {};
      const nextCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>> = {};

      PROVIDERS.forEach((p, i) => {
        const entry = results[i];
        if (!entry) {
          return;
        }

        nextCatalog[p] = entry.models;
        nextCacheCatalog[p] = entry.cache;
      });

      setProviderModelCatalog(nextCatalog);
      setProviderModelCacheCatalog(nextCacheCatalog);
    } catch (error) {
      console.error('Error loading provider models:', error);
    } finally {
      if (providerModelsRequestIdRef.current === requestId) {
        setProviderModelsLoading(false);
        setProviderModelsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  useEffect(() => {
    let cancelled = false;

    const loadCapabilities = async () => {
      try {
        const response = await authenticatedFetch('/api/providers/capabilities');
        const body = (await response.json()) as ProviderCapabilitiesApiResponse;
        if (cancelled || !body.success || !Array.isArray(body.data?.providers)) {
          return;
        }

        const byProvider: Partial<Record<LLMProvider, ProviderCapabilities>> = {};
        for (const capabilities of body.data.providers) {
          byProvider[capabilities.provider] = capabilities;
        }
        setProviderCapabilities(byProvider);
      } catch (error) {
        console.error('Error loading provider capabilities:', error);
      }
    };

    void loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  const getPermissionModesForProvider = useCallback((targetProvider: LLMProvider): PermissionMode[] => {
    const capabilityModes = providerCapabilities?.[targetProvider]?.permissionModes;
    if (capabilityModes && capabilityModes.length > 0) {
      return capabilityModes as PermissionMode[];
    }
    return FALLBACK_PERMISSION_MODES[targetProvider] ?? ['default'];
  }, [providerCapabilities]);

  const getDefaultPermissionModeForProvider = useCallback((targetProvider: LLMProvider): PermissionMode => {
    const modes = getPermissionModesForProvider(targetProvider);
    const capabilityDefault = providerCapabilities?.[targetProvider]?.defaultPermissionMode as PermissionMode | undefined;
    if (capabilityDefault && modes.includes(capabilityDefault)) {
      return capabilityDefault;
    }
    return modes[0] ?? 'default';
  }, [getPermissionModesForProvider, providerCapabilities]);

  const getSupportsEffortForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsEffort;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return Boolean(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider]?.length);
  }, [providerCapabilities]);

  const pickStoredOrCurrent = (
    storageKey: string,
    current: string,
    def: ProviderModelsDefinition,
  ): string => {
    const stored = localStorage.getItem(storageKey);
    if (stored && def.OPTIONS.some((o) => o.value === stored)) {
      return stored;
    }
    if (current && def.OPTIONS.some((o) => o.value === current)) {
      return current;
    }
    return def.DEFAULT;
  };

  const getModelOption = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): ProviderModelOption | null => {
    const definition = providerModelCatalog[targetProvider];
    if (!definition) {
      return null;
    }

    return definition.OPTIONS.find((option) => option.value === model) ?? null;
  }, [providerModelCatalog]);

  const getEffortOptionsForModel = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): NonNullable<ProviderModelOption['effort']>['values'] => {
    if (!getSupportsEffortForProvider(targetProvider)) {
      return [];
    }

    const option = getModelOption(targetProvider, model);
    if (option) {
      return option.effort?.values ?? [];
    }

    return toProviderEffortOptions(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider] ?? []);
  }, [getModelOption, getSupportsEffortForProvider]);

  const getAllowedEffortValues = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): string[] => (
    getEffortOptionsForModel(targetProvider, model).map((value) => value.value)
  ), [getEffortOptionsForModel]);

  const reconcileStoredEffort = useCallback((
    targetProvider: LLMProvider,
    model: string,
    currentEffort: string,
  ): string => {
    const allowedValues = getAllowedEffortValues(targetProvider, model);
    if (allowedValues.length === 0) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (currentEffort === DEFAULT_EFFORT_VALUE || !currentEffort) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (allowedValues.includes(currentEffort)) {
      return currentEffort;
    }

    return DEFAULT_EFFORT_VALUE;
  }, [getAllowedEffortValues]);

  const providerModels = useMemo<Record<LLMProvider, string>>(() => ({
    claude: claudeModel,
    cursor: cursorModel,
    codex: codexModel,
    opencode: opencodeModel,
  }), [claudeModel, cursorModel, codexModel, opencodeModel]);

  useEffect(() => {
    const claude = providerModelCatalog.claude;
    if (claude) {
      const next = pickStoredOrCurrent('claude-model', claudeModel, claude);
      if (next !== claudeModel) {
        setClaudeModel(next);
      }
      if (localStorage.getItem('claude-model') !== next) {
        localStorage.setItem('claude-model', next);
      }
    }
  }, [providerModelCatalog.claude, claudeModel]);

  useEffect(() => {
    const cursor = providerModelCatalog.cursor;
    if (cursor) {
      const next = pickStoredOrCurrent('cursor-model', cursorModel, cursor);
      if (next !== cursorModel) {
        setCursorModel(next);
      }
      if (localStorage.getItem('cursor-model') !== next) {
        localStorage.setItem('cursor-model', next);
      }
    }
  }, [providerModelCatalog.cursor, cursorModel]);

  useEffect(() => {
    const codex = providerModelCatalog.codex;
    if (codex) {
      const next = pickStoredOrCurrent('codex-model', codexModel, codex);
      if (next !== codexModel) {
        setCodexModel(next);
      }
      if (localStorage.getItem('codex-model') !== next) {
        localStorage.setItem('codex-model', next);
      }
    }
  }, [providerModelCatalog.codex, codexModel]);

  useEffect(() => {
    const opencode = providerModelCatalog.opencode;
    if (opencode) {
      const next = pickStoredOrCurrent('opencode-model', opencodeModel, opencode);
      if (next !== opencodeModel) {
        setOpenCodeModel(next);
      }
      if (localStorage.getItem('opencode-model') !== next) {
        localStorage.setItem('opencode-model', next);
      }
    }
  }, [providerModelCatalog.opencode, opencodeModel]);

  useEffect(() => {
    const nextEfforts: Partial<Record<LLMProvider, string>> = {};
    let hasUpdates = false;

    for (const targetProvider of PROVIDERS) {
      const currentEffort = providerEfforts[targetProvider] ?? DEFAULT_EFFORT_VALUE;
      const nextEffort = reconcileStoredEffort(targetProvider, providerModels[targetProvider], currentEffort);
      if (nextEffort === currentEffort) {
        continue;
      }

      nextEfforts[targetProvider] = nextEffort;
      localStorage.setItem(`${targetProvider}-effort`, nextEffort);
      hasUpdates = true;
    }

    if (hasUpdates) {
      setProviderEfforts((previous) => ({ ...previous, ...nextEfforts }));
    }
  }, [providerEfforts, providerModels, reconcileStoredEffort]);

  const syncPermissionModeWithServer = useCallback((freshServerModes?: StoredPermissionModePreferences) => {
    // Accepts an explicit snapshot (used by the reconnect refresh below,
    // which awaits a fresh GET before calling this) so callers that just
    // fetched newer data don't have to wait for the setState from that fetch
    // to flush through a render before this reads it — falling back to the
    // last state we have otherwise.
    const activeServerModes = freshServerModes ?? serverPermissionModes;
    const validModes = getPermissionModesForProvider(provider);

    // Server values (once resolved) are authoritative; localStorage is only
    // the instant-paint fallback for values the server hasn't synced yet
    // (in flight, offline, or never written from this browser).
    const serverSessionMode = selectedSession?.id
      ? activeServerModes?.sessions?.[selectedSession.id]
      : undefined;
    const sessionSavedMode = selectedSession?.id
      ? (localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null)
      : null;
    const validServerSessionMode = serverSessionMode && validModes.includes(serverSessionMode as PermissionMode)
      ? (serverSessionMode as PermissionMode)
      : null;
    const validSessionSavedMode = sessionSavedMode && validModes.includes(sessionSavedMode)
      ? sessionSavedMode
      : null;
    // Whether this session already has an explicit mode of its own. A
    // session with no mode of its own must resolve to the provider's true
    // default, never to a value shared with other sessions — otherwise a
    // mode change on any session bleeds into every other one (including
    // brand-new sessions that haven't been created yet). Prefer the
    // server's copy over a possibly-stale local one when both exist.
    const ownSessionMode = validServerSessionMode ?? validSessionSavedMode;

    // The one legitimate cross-session carryover: a brand-new chat has no
    // session id until the first send, so a mode picked beforehand needs to
    // survive the transition from "no id" to "just-assigned id" — otherwise
    // it would snap back to the default the instant the id appears. This is
    // scoped to that exact transition (via an in-memory, single-use ref) so
    // it cannot leak into any other session.
    const isNewlyAssignedSessionId = Boolean(selectedSession?.id) && !hadSessionIdRef.current;
    hadSessionIdRef.current = Boolean(selectedSession?.id);
    const carryoverMode = isNewlyAssignedSessionId ? pendingCarryoverModeRef.current : null;
    if (selectedSession?.id) {
      pendingCarryoverModeRef.current = null;
    }

    const resolvedMode = ownSessionMode
      ?? carryoverMode
      ?? getDefaultPermissionModeForProvider(provider);
    setPermissionMode(resolvedMode);

    if (!selectedSession?.id) {
      return;
    }

    if (!ownSessionMode) {
      // Seed this session's own entry, in both layers, in this same code
      // path, so it becomes independently sticky from now on instead of
      // continuing to live-track whatever mode is last picked elsewhere
      // (which is exactly what "bleeds" a change across sessions). A
      // stale/invalid stored value counts as "no session mode" and gets
      // reseeded here too.
      localStorage.setItem(`permissionMode-${selectedSession.id}`, resolvedMode);

      // Same guard cyclePermissionMode uses before PATCHing: writing the
      // server sessions map before the initial GET has resolved would
      // clobber it with a partial view built without knowing what else is
      // already stored there for other sessions/providers.
      if (preferencesResolvedRef.current) {
        const sessionId = selectedSession.id;
        setServerPermissionModes((previous) => {
          const next: StoredPermissionModePreferences = {
            sessions: { ...(previous?.sessions ?? {}), [sessionId]: resolvedMode },
          };

          void api.user.patchPreferences({ permissionMode: next }).catch((error) => {
            console.error('Error syncing permission mode preference:', error);
          });

          return next;
        });
      }
    } else if (validServerSessionMode && validServerSessionMode !== sessionSavedMode) {
      // The session's own entry already exists server-side and differs from
      // the local cache (e.g. changed from another device) — refresh the
      // cache so it doesn't keep serving a stale value while offline.
      localStorage.setItem(`permissionMode-${selectedSession.id}`, validServerSessionMode);
    }
  }, [
    selectedSession?.id,
    provider,
    serverPermissionModes,
    getDefaultPermissionModeForProvider,
    getPermissionModesForProvider,
  ]);

  useEffect(() => {
    syncPermissionModeWithServer();
  }, [syncPermissionModeWithServer]);

  // Reconnect-triggered resync: the WS `preferences_updated` broadcast is
  // the only thing that otherwise keeps `serverPermissionModes` current, and
  // broadcasts sent while this client was offline are simply never
  // delivered — so a mode change made from another device during the outage
  // would be invisible here. Re-fetching before resolving avoids resolving
  // (and potentially re-seeding/PATCHing) against that stale cache.
  const refreshPermissionModeFromServer = useCallback(async () => {
    try {
      const fresh = await fetchPermissionModePreferences();
      preferencesResolvedRef.current = true;
      setServerPermissionModes(fresh);
      syncPermissionModeWithServer(fresh);
    } catch (error) {
      console.error('Error refreshing permission mode preferences on reconnect:', error);
      syncPermissionModeWithServer();
    }
  }, [fetchPermissionModePreferences, syncPermissionModeWithServer]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    localStorage.setItem('selected-provider', selectedSession.__provider);
  }, [provider, selectedSession]);

  // Permission prompts belong to a session, not to the transient provider
  // selection that is synchronized after navigation.
  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  useEffect(() => {
    if (provider !== 'cursor') {
      return;
    }

    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) {
          return;
        }

        const modelId = data.config.model.modelId as string;
        if (!localStorage.getItem('cursor-model')) {
          setCursorModel(modelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(provider);

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    } else {
      // A brand-new chat has no session id yet — remember the choice
      // in-memory only, so it survives the transition to the real id
      // (assigned right after the first send) without leaking into any
      // other, unrelated session the way a persisted per-provider "last
      // picked anywhere" value used to.
      pendingCarryoverModeRef.current = nextMode;
    }

    // Nothing to sync to the server for a not-yet-created session — there's
    // no session id to key the change under yet (see the carryover ref
    // above). Also skip until the initial GET has resolved: the PATCH
    // shallow-merges only at the top level, so sending a `permissionMode`
    // object built before we know the existing sessions map would clobber
    // values already stored for other sessions.
    if (!selectedSession?.id || !preferencesResolvedRef.current) {
      return;
    }

    setServerPermissionModes((previous) => {
      const next: StoredPermissionModePreferences = {
        sessions: { ...(previous?.sessions ?? {}), [selectedSession.id]: nextMode },
      };

      void api.user.patchPreferences({ permissionMode: next }).catch((error) => {
        console.error('Error syncing permission mode preference:', error);
      });

      return next;
    });
  }, [permissionMode, provider, selectedSession?.id, getPermissionModesForProvider]);

  const resolvePermissionModeForProvider = useCallback((
    targetProvider: LLMProvider,
    requestedMode: PermissionMode | string,
  ): PermissionMode => {
    const validModes = getPermissionModesForProvider(targetProvider);
    return validModes.includes(requestedMode as PermissionMode)
      ? requestedMode as PermissionMode
      : getDefaultPermissionModeForProvider(targetProvider);
  }, [getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      setStoredProviderModel(targetProvider, model);
      return {
        scope: 'default' as const,
        changed: false,
        model,
      };
    }

    const response = await authenticatedFetch(
      `/api/providers/${targetProvider}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
      },
    );

    const body = (await response.json()) as ChangeActiveModelApiResponse;
    if (!response.ok || !body.success || !body.data?.supported) {
      throw new Error('Unable to change the active model for this session.');
    }

    return {
      scope: 'session' as const,
      changed: body.data.changed === true,
      model: body.data.model || model,
    };
  }, [setStoredProviderModel]);

  const currentProviderEffortOptions = useMemo(() => {
    return getEffortOptionsForModel(provider, providerModels[provider]);
  }, [getEffortOptionsForModel, provider, providerModels]);
  const currentProviderEffort = useMemo(() => {
    return reconcileStoredEffort(
      provider,
      providerModels[provider],
      providerEfforts[provider] ?? DEFAULT_EFFORT_VALUE,
    );
  }, [provider, providerEfforts, providerModels, reconcileStoredEffort]);

  return {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    opencodeModel,
    setOpenCodeModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    refreshPermissionModeFromServer,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels: () => loadProviderModels({ bypassCache: true }),
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  };
}
