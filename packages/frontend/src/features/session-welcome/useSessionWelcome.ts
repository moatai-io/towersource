import { useCallback, useEffect, useRef, useState } from 'react';

export interface WelcomeContent {
  contextLine: string;
  question: string;
  choices: Array<{ label: string; message: string }>;
}

/** Model output is display data only, never instructions or trusted send metadata. */
export function parseWelcomeContent(value: unknown): WelcomeContent | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const boundedText = (text: unknown, max: number): text is string =>
    typeof text === 'string' && text.trim().length > 0 && text.length <= max;
  if (typeof data.contextLine !== 'string' || data.contextLine.length > 900
    || !boundedText(data.question, 160) || !Array.isArray(data.choices)
    || data.choices.length < 2 || data.choices.length > 3) return null;
  const choices: WelcomeContent['choices'] = [];
  for (const choice of data.choices) {
    if (!choice || typeof choice !== 'object'
      || !boundedText(choice.label, 40) || !boundedText(choice.message, 240)) return null;
    choices.push({ label: choice.label.trim(), message: choice.message.trim() });
  }
  return { contextLine: data.contextLine.trim(), question: data.question.trim(), choices };
}

export function useSessionWelcome({ sessionId, projectId, locale, enabled }: {
  sessionId: string | null;
  projectId: string | null;
  locale: string;
  enabled: boolean;
}) {
  const [loadingScope, setLoadingScope] = useState<string | null>(null);
  const scope = JSON.stringify([sessionId, projectId, locale]);
  const guard = useRef({ scope, interacted: false, controller: null as AbortController | null });
  // Reset at render time: restored composer drafts can report interaction in a child effect
  // before this hook's request effect runs. Never clear that interaction in the effect.
  if (guard.current.scope !== scope) {
    guard.current = { scope, interacted: false, controller: null };
  }
  const [result, setResult] = useState<{ scope: string; content: WelcomeContent } | null>(null);
  const onInteraction = useCallback(() => {
    guard.current.interacted = true;
    setLoadingScope(null);
    guard.current.controller?.abort();
  }, []);

  useEffect(() => {
    if (!enabled || !sessionId || !projectId || guard.current.interacted) return;
    const controller = new AbortController();
    const requestGuard = guard.current;
    requestGuard.controller = controller;
    let disposed = false;
    setLoadingScope(scope);
    const timeout = window.setTimeout(() => { controller.abort(); setLoadingScope(current => current === scope ? null : current); }, 6500);
    void (async () => {
      try {
        const response = await fetch('/api/session-welcome', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, sessionId, locale }),
          signal: controller.signal,
        });
        if (!response.ok) return;
        const content = parseWelcomeContent(await response.json());
        if (content && !disposed && !controller.signal.aborted && !requestGuard.interacted
          && guard.current === requestGuard) setResult({ scope, content });
      } catch {
        // The localized static welcome is the complete fallback; no error/loading UI needed.
      } finally {
        if (!disposed) setLoadingScope(current => current === scope ? null : current);
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
      if (requestGuard.controller === controller) requestGuard.controller = null;
    };
  }, [enabled, sessionId, projectId, locale, scope]);

  return { isLoading: enabled && loadingScope === scope && !guard.current.interacted, content: result?.scope === scope ? result.content : null, onInteraction };
}
