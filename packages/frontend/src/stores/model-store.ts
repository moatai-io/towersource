import { create } from 'zustand';
import { useMemo } from 'react';
import { useSessionStore } from './session-store';
import { decideEnginePick, patchSessionModel, type EnginePickDecision } from './engine-pick';

export interface ModelOption {
  id: string;
  name: string;
  badge: string;
  /** Tower-managed preset or a directly selected model. */
  kind?: 'policy' | 'direct';
  /** Stable user-facing alias. */
  policyAlias?: 'core' | 'lite';
  /** Runtime model selected by this alias. */
  runtimeModelId?: string;
  /** User-facing maker; not the LiteLLM transport provider. */
  company?: string;
  /** LiteLLM-reported USD per million tokens, when both rates are available. */
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  /** Optional input context window from backend models.json. */
  contextWindow?: number;
  /** Product-supported reasoning efforts for this exact runtime model. */
  reasoningEfforts?: EffortLevel[];
}

export interface ModelDefaults {
  session: string;
  ai_reply: string;
  ai_task: string;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const DEFAULT_DEFAULTS: ModelDefaults = {
  session: 'pi:preset/core',
  ai_reply: 'pi:litellm-responses/mini',
  ai_task: 'pi:litellm-responses/mini',
};

/** Frontend model IDs carry an engine prefix for non-Claude models. Backend
 * defaults/models.json intentionally store engine-native IDs (e.g.
 * `litellm-responses/mini`) because backend quick-reply paths pass them directly
 * to engines. Normalize when those values enter the browser store.
 */
export function normalizeFrontendModelId(id: string | undefined | null): string {
  if (!id) return '';
  if (id.startsWith('pi:') || id.startsWith('local:') || id.startsWith('claude-')) return id;
  if (id.includes('/')) return `pi:${id}`;
  return id;
}

function normalizeDefaults(defaults: ModelDefaults): ModelDefaults {
  return {
    session: normalizeFrontendModelId(defaults.session),
    ai_reply: normalizeFrontendModelId(defaults.ai_reply),
    ai_task: normalizeFrontendModelId(defaults.ai_task),
  };
}

interface ModelState {
  availableModels: ModelOption[];
  piModels: ModelOption[];
  localModels: ModelOption[];
  selectedModel: string;
  connectionType: string;
  defaults: ModelDefaults;

  setAvailableModels: (models: ModelOption[]) => void;
  setPiModels: (models: ModelOption[]) => void;
  setLocalModels: (models: ModelOption[]) => void;
  setSelectedModel: (id: string) => void;
  setConnectionType: (type: string) => void;
  setDefaults: (defaults: ModelDefaults) => void;
}

export const useModelStore = create<ModelState>((set) => ({
  availableModels: [],
  piModels: [],
  localModels: [],
  selectedModel: 'pi:preset/core',
  connectionType: 'MAX',
  defaults: DEFAULT_DEFAULTS,

  setAvailableModels: (models) => set({ availableModels: models }),
  setPiModels: (models) => set({ piModels: models }),
  setLocalModels: (models) => set({ localModels: models }),
  setSelectedModel: (id) => {
    const normalized = normalizeFrontendModelId(id);
    localStorage.setItem('selectedModel', normalized);
    set({ selectedModel: normalized });
  },
  setConnectionType: (type) => set({ connectionType: type }),
  setDefaults: (defaults) => set({ defaults: normalizeDefaults(defaults) }),
}));

/**
 * Reconcile localStorage-persisted `selectedModel` with the server-side model
 * registry. Called once after `/api/config` loads models + defaults.
 *
 * New sessions use the current Core preset, regardless of the last model picked
 * for an existing session.
 */
export function getNewSessionModel(): string {
  // A per-session picker choice must not become the next session's default.
  // Core is a stable preset resolved against the current admin mapping at run time.
  return useModelStore.getState().piModels.find(model => model.policyAlias === 'core')?.id
    ?? 'pi:preset/core';
}

/** Replace a retired picker choice with Core once the registry has loaded. */
export function reconcileSelectedModel(): void {
  const s = useModelStore.getState();
  const ids = new Set<string>([
    ...s.availableModels.map((m) => m.id),
    ...s.piModels.map((m) => m.id),
    ...s.localModels.map((m) => m.id),
  ]);
  if (ids.size === 0) return; // registry still loading
  if (ids.has(s.selectedModel)) return;

  const fallback = getNewSessionModel();
  if (!fallback) return;

  console.info(
    `[model-store] selectedModel "${s.selectedModel}" not in registry — resetting to "${fallback}"`,
  );
  s.setSelectedModel(fallback);
}

/** Extract engine from model ID. 'pi:...' or provider/model → 'pi', 'local:...' → 'local', otherwise 'claude' */
export function getEngineFromModel(modelId: string): 'claude' | 'pi' | 'local' {
  if (modelId.startsWith('pi:') || modelId.includes('/')) return 'pi';
  if (modelId.startsWith('local:')) return 'local';
  return 'claude';
}

/** Strip engine prefix from model ID for backend. 'pi:openrouter/...' → 'openrouter/...', 'local:foo' → 'foo' */
export function getModelIdForBackend(modelId: string): string {
  if (modelId.startsWith('pi:preset/')) return modelId.slice(3);
  if (modelId.startsWith('pi:')) return modelId.slice(3);
  if (modelId.startsWith('local:')) return modelId.slice(6);
  return modelId;
}

/**
 * Convert a session's stored `modelUsed` (DB format, no prefix) to the
 * frontend ID format (with `pi:` prefix for pi-engine sessions).
 * Returns undefined if the session has no stored model.
 */
export function modelIdFromSession(
  session: { engine?: string; modelUsed?: string } | null | undefined,
): string | undefined {
  if (!session?.modelUsed) return undefined;
  if (session.engine === 'pi') {
    const model = session.modelUsed.replace(/^pi:/, '');
    if (model === 'policy/core' || model === 'policy/lite') return `pi:preset/${model.split('/')[1]}`;
    return `pi:${model}`;
  }
  if (session.engine === 'local' && !session.modelUsed.startsWith('local:')) {
    return `local:${session.modelUsed}`;
  }
  return session.modelUsed;
}

/**
 * Resolve the effective model for a chat send:
 * - active session's stored modelUsed takes precedence (per-session intent)
 * - fall back to the global selectedModel (default for new sessions)
 *
 * The backend additionally validates/falls back again, so even if this
 * returns a mismatched model it won't crash — but matching here keeps
 * the UI and the actual turn in sync.
 */
export function resolveEffectiveModel(
  session: { engine?: string; modelUsed?: string } | null | undefined,
  globalSelected: string,
): string {
  return modelIdFromSession(session) ?? globalSelected;
}

/**
 * Session-aware model picker — shared by ModelSelector (desktop) and the
 * Header's inline mobile selector.
 *
 * Returns:
 *  - `effectiveSelected`: the frontend model ID that should be shown as picked
 *  - `sessionEngine`: engine of the active session (or undefined if none)
 *  - `visibleClaudeModels` / `visiblePiModels` / `visibleLocalModels`: dropdown groups filtered by engine
 *  - `pick(modelId)`: update either the session's modelUsed (+ PATCH backend)
 *     or the global default if no session is active
 */
export function useSessionAwareModel() {
  const availableModels = useModelStore((s) => s.availableModels);
  const piModels = useModelStore((s) => s.piModels);
  const localModels = useModelStore((s) => s.localModels);
  const selectedModel = useModelStore((s) => s.selectedModel);
  const setSelectedModel = useModelStore((s) => s.setSelectedModel);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const updateSessionMeta = useSessionStore((s) => s.updateSessionMeta);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );

  const sessionEngine = activeSession?.engine as 'claude' | 'pi' | 'local' | undefined;

  // Resolve the model to display/send:
  //  1. session's stored modelUsed (authoritative per-session choice)
  //  2. if the active session is Pi but has no modelUsed yet, fall back to
  //     the first registered Pi model (NOT the global default, which is
  //     typically a Claude model — would render the wrong badge/name)
  //  3. otherwise, the global selectedModel (new-session default)
  const effectiveSelected = useMemo(() => {
    const fromSession = modelIdFromSession(activeSession);
    if (fromSession) return fromSession;
    if (sessionEngine === 'pi' && piModels.length > 0) return piModels[0].id;
    if (sessionEngine === 'local' && localModels.length > 0) return localModels[0].id;
    if (sessionEngine === 'claude' && availableModels.length > 0) {
      // Only override global if it's a non-Claude model (engine mismatch guard)
      if (selectedModel.startsWith('pi:') || selectedModel.startsWith('local:')) return availableModels[0].id;
    }
    return selectedModel;
  }, [activeSession, sessionEngine, piModels, localModels, availableModels, selectedModel]);

  // Always show all model groups so the user can switch engines on the fly
  const visibleClaudeModels = availableModels;
  const visiblePiModels = piModels;
  const visibleLocalModels = localModels;

  /**
   * Pick a model. Returns a decision the caller must finish:
   *  - 'model_only' / 'safe_swap' are applied here immediately (PATCH).
   *  - 'needs_confirm' is returned UNAPPLIED — the caller (Header) shows the
   *    confirm modal and, on confirm, calls confirmEngineSwitch() + applyPickedModel().
   *  - 'no_session' — global default updated, nothing else to do.
   *
   * Why return instead of confirming inline: a store hook can't render a
   * modal. Keeping the decision pure (decideEnginePick) and the UI in the
   * component is the cleanest split + lets us unit-test the logic.
   *
   * See: workspace/decisions/2026-05-19-engine-hard-switch-design.md
   */
  const pick = (modelId: string): EnginePickDecision | { kind: 'no_session' } => {
    if (!activeSession) {
      setSelectedModel(modelId);
      return { kind: 'no_session' };
    }
    const pickedEngine = getEngineFromModel(modelId);
    const backendModel = getModelIdForBackend(modelId);

    // turnCount/userTurnCount > 0 means a real turn happened → engine swap is lossy.
    const hasHistory = (activeSession.turnCount ?? 0) > 0 || (activeSession.userTurnCount ?? 0) > 0;

    const decision = decideEnginePick({ sessionEngine, pickedEngine, backendModel, hasHistory });

    if (decision.kind === 'model_only') {
      updateSessionMeta(activeSession.id, { modelUsed: backendModel });
      patchSessionModel(activeSession.id, { modelUsed: backendModel })
        .catch((err) => console.warn('[useSessionAwareModel] persist modelUsed failed:', err));
      setSelectedModel(modelId);
    } else if (decision.kind === 'safe_swap') {
      // Empty session — lossless raw swap, no rehydrate needed.
      updateSessionMeta(activeSession.id, { modelUsed: backendModel, engine: decision.toEngine });
      patchSessionModel(activeSession.id, { modelUsed: backendModel, engine: decision.toEngine })
        .catch((err) => console.warn('[useSessionAwareModel] persist safe_swap failed:', err));
      setSelectedModel(modelId);
    }
    // needs_confirm: do NOT mutate anything yet. Caller drives the modal.

    return decision;
  };

  /**
   * Apply the model selection AFTER a confirmed engine switch succeeded.
   * switch-engine already changed sessions.engine + rehydrated; here we only
   * persist the per-session modelUsed and update local stores.
   */
  const applyPickedModel = (modelId: string) => {
    const backendModel = getModelIdForBackend(modelId);
    const pickedEngine = getEngineFromModel(modelId);
    if (activeSession) {
      updateSessionMeta(activeSession.id, { modelUsed: backendModel, engine: pickedEngine });
      patchSessionModel(activeSession.id, { modelUsed: backendModel })
        .catch((err) => console.warn('[useSessionAwareModel] persist post-switch model failed:', err));
    }
    setSelectedModel(modelId);
  };

  return {
    effectiveSelected,
    sessionEngine,
    visibleClaudeModels,
    visiblePiModels,
    visibleLocalModels,
    pick,
    applyPickedModel,
  };
}
