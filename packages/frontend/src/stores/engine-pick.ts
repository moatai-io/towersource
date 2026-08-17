/**
 * Engine-pick decision logic — what should happen when a user picks a model
 * from the Header dropdown, given the active session's current engine.
 *
 * Background — the bug this guards against:
 *   Before Phase 3, picking a different-engine model fired a raw
 *   `PATCH /api/sessions/:id { engine }` which swapped sessions.engine with
 *   NO rehydrate. The new engine started from an empty native session →
 *   silent conversation-context loss. See
 *   workspace/decisions/2026-05-19-engine-hard-switch-design.md.
 *
 * Now the picker routes engine changes through one of three outcomes:
 *   - model_only   : same engine, just persist modelUsed (cheap PATCH)
 *   - safe_swap    : different engine BUT the session has no turns yet, so
 *                    there's nothing to lose — a raw PATCH is fine and avoids
 *                    a pointless rehydrate of an empty history.
 *   - needs_confirm: different engine AND the session has real history —
 *                    must confirm with the user, then POST /switch-engine
 *                    (which rehydrates + guards + writes an audit row).
 *
 * decideEnginePick is a pure function (unit-tested). confirmEngineSwitch is
 * the async side-effecting call used only for the needs_confirm path.
 */

export type EnginePickDecision =
  | { kind: 'model_only'; backendModel: string }
  | { kind: 'safe_swap'; toEngine: string; backendModel: string }
  | { kind: 'needs_confirm'; fromEngine: string; toEngine: string; backendModel: string };

export interface DecideEnginePickArgs {
  /** Current engine of the active session ('claude' | 'pi' | 'local' | undefined). */
  sessionEngine: string | undefined;
  /** Engine implied by the picked model. */
  pickedEngine: string;
  /** Model id stripped of the frontend prefix, ready for the backend. */
  backendModel: string;
  /**
   * Whether the session has any real conversation history. Derived from
   * turnCount / message count by the caller. When false, an engine swap is
   * lossless (nothing to carry over).
   */
  hasHistory: boolean;
}

export function decideEnginePick(args: DecideEnginePickArgs): EnginePickDecision {
  const { sessionEngine, pickedEngine, backendModel, hasHistory } = args;

  // Same engine (or session has no engine yet) → never a switch.
  if (!sessionEngine || pickedEngine === sessionEngine) {
    return { kind: 'model_only', backendModel };
  }

  // Different engine, but empty session → swap freely, nothing to rehydrate.
  if (!hasHistory) {
    return { kind: 'safe_swap', toEngine: pickedEngine, backendModel };
  }

  // Different engine + real history → must confirm + rehydrate.
  return { kind: 'needs_confirm', fromEngine: sessionEngine, toEngine: pickedEngine, backendModel };
}

// ─────────────────────────────────────────────────────────────────────
// Side-effecting calls
// ─────────────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/** PATCH the session's modelUsed (and optionally engine for safe_swap). */
export async function patchSessionModel(
  sessionId: string,
  body: { modelUsed: string; engine?: string },
): Promise<void> {
  await fetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

export interface SwitchEngineApiResult {
  ok: boolean;
  /** Present on success. */
  fromEngine?: string;
  toEngine?: string;
  /** Present on a structured failure. */
  error?: { code: string; message: string };
  /** HTTP status, for the caller to distinguish 409 vs 500 etc. */
  status: number;
}

/**
 * POST /api/sessions/:id/switch-engine — the rehydrating, guarded path.
 *
 * Returns a normalized result rather than throwing, so the modal can show a
 * meaningful message for RUNNING / PENDING_TOOL_USE / REHYDRATE_FAILED
 * without try/catch noise at every call site. Network errors surface as
 * { ok:false, status:0 }.
 */
export async function confirmEngineSwitch(
  sessionId: string,
  toEngine: string,
  reason = 'user_request',
  targetModel?: string,
): Promise<SwitchEngineApiResult> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/switch-engine`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ toEngine, reason, ...(targetModel ? { targetModel } : {}) }),
    });
    let body: any = {};
    try { body = await res.json(); } catch { /* empty body */ }
    return {
      ok: res.ok && body?.ok !== false,
      fromEngine: body?.fromEngine,
      toEngine: body?.toEngine,
      error: body?.error,
      status: res.status,
    };
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK', message: '네트워크 오류로 엔진 전환에 실패했습니다.' } };
  }
}
