import { useCallback, useEffect, useRef, useState } from 'react';

export interface SessionWaitAlarm {
  id: string;
  sessionId: string;
  status: 'pending' | 'admitted' | 'cancelled' | 'superseded';
  wakeAt: string;
  reason: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface AlarmState {
  sessionId: string | null;
  alarm: SessionWaitAlarm | null;
  canManage: boolean;
  error: 'load' | 'conflict' | 'forbidden' | 'invalid' | 'action' | null;
  busy: boolean;
}

export const WAIT_ALARM_POLL_MS = 30_000;

function headers() {
  const token = localStorage.getItem('token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** Persisted alarm projection only: this hook never drives or resumes the agent clock. */
export function useSessionWaitAlarm(sessionId: string | null, refreshKey: boolean) {
  const [state, setState] = useState<AlarmState>({ sessionId, alarm: null, canManage: false, error: null, busy: false });
  const request = useRef<{ controller: AbortController; sequence: number } | null>(null);
  const sequence = useRef(0);
  const actionPending = useRef(false);
  const endpoint = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/wait-alarm` : null;

  const refresh = useCallback(async (preserveActionError = false) => {
    if (!endpoint || document.visibilityState === 'hidden' || actionPending.current) return;
    request.current?.controller.abort();
    const controller = new AbortController();
    const id = ++sequence.current;
    request.current = { controller, sequence: id };
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const response = await fetch(endpoint, { headers: headers(), signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('load');
      const data = await response.json() as { alarm: SessionWaitAlarm | null; canManage?: boolean };
      if (controller.signal.aborted || sequence.current !== id) return;
      setState((previous) => ({
        sessionId, alarm: data.alarm, canManage: data.canManage ?? previous.canManage,
        error: preserveActionError && previous.error !== 'load' ? previous.error : null,
        busy: false,
      }));
    } catch {
      if ((controller.signal.aborted && !timedOut) || sequence.current !== id) return;
      setState((previous) => ({ ...previous, sessionId, error: 'load' }));
    } finally {
      window.clearTimeout(timeout);
    }
  }, [endpoint, sessionId]);

  useEffect(() => {
    setState({ sessionId, alarm: null, canManage: false, error: null, busy: false });
    actionPending.current = false;
    void refresh();
    // No hidden-tab requests. All listeners/timers are bounded to this mounted session.
    const poll = window.setInterval(() => { void refresh(); }, WAIT_ALARM_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!actionPending.current) {
          request.current?.controller.abort();
          ++sequence.current;
        }
      } else void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
      request.current?.controller.abort();
      ++sequence.current;
    };
  }, [refresh, sessionId]);

  const priorRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (priorRefreshKey.current !== refreshKey) void refresh();
    priorRefreshKey.current = refreshKey;
  }, [refresh, refreshKey]);

  const act = useCallback(async (action: 'now' | 'cancel' | 'reschedule', wakeAt?: string) => {
    if (!endpoint || state.sessionId !== sessionId || !state.alarm || !state.canManage || actionPending.current) return false;
    actionPending.current = true;
    request.current?.controller.abort();
    const controller = new AbortController();
    const id = ++sequence.current;
    request.current = { controller, sequence: id };
    setState((previous) => ({ ...previous, busy: true, error: null }));
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const response = await fetch(`${endpoint}/${action}`, {
        method: 'POST', headers: headers(), signal: controller.signal,
        body: JSON.stringify({ id: state.alarm.id, version: state.alarm.version, ...(wakeAt ? { wakeAt } : {}) }),
      });
      if (controller.signal.aborted || sequence.current !== id) return false;
      if (!response.ok) {
        const error = response.status === 409 ? 'conflict' : response.status === 403 ? 'forbidden' : response.status === 400 ? 'invalid' : 'action';
        setState((previous) => ({ ...previous, busy: false, error, ...(error === 'forbidden' ? { canManage: false } : {}) }));
        return false;
      }
      const data = await response.json() as { alarm: SessionWaitAlarm | null; canManage?: boolean };
      if (controller.signal.aborted || sequence.current !== id) return false;
      setState((previous) => ({ sessionId, alarm: data.alarm, canManage: data.canManage ?? previous.canManage, error: null, busy: false }));
      return true;
    } catch {
      if ((!controller.signal.aborted || timedOut) && sequence.current === id) setState((previous) => ({ ...previous, busy: false, error: 'action' }));
      return false;
    } finally {
      window.clearTimeout(timeout);
      if (sequence.current === id) {
        actionPending.current = false;
        // Resolve stale versions and ambiguous responses by reading, never retrying a write.
        void refresh(true);
      }
    }
  }, [endpoint, refresh, sessionId, state.alarm, state.canManage, state.sessionId]);

  // A session switch must not briefly show the prior session's alarm or controls.
  const current = state.sessionId === sessionId ? state : { sessionId, alarm: null, canManage: false, error: null, busy: false };
  return { ...current, refresh, act };
}
