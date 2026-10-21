import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const selection = readFileSync(new URL('./useSessionSelection.ts', import.meta.url), 'utf8');

describe('session selection ownership', () => {
  it('keeps App on hook wiring and moves message hydration out', () => {
    expect(app).toContain('useSessionSelection({ token, setActiveRuntimeSession: setActiveSession })');
    expect(app).not.toContain('const handleSelectSession = useCallback');
    expect(selection).toContain('export function useSessionSelection');
    expect(selection).toContain('const handleSelectSession = useCallback');
  });

  it('preserves cache hit, background refresh, and cache miss paths', () => {
    expect(selection).toContain('sessionMsgCache.get(session.id)');
    expect(selection).toContain("logClientPerf('session-select-cache-hit'");
    expect(selection).toContain("logClientPerf('session-select-cache-refresh'");
    expect(selection).toContain("logClientPerf('session-select-fetch-full'");
    expect(selection).toContain("startClientPerfTrace('session-select-to-paint'");
    expect(selection).toContain("markClientPerfTrace('session-select-to-paint', session.id, 'messagesNormalized'");
    expect(selection).toContain("markClientPerfTrace('session-select-to-paint', session.id, 'storeUpdated'");
    expect(selection).toContain('/full?limit=${PAGE_SIZE}');
  });

  it('guards session races, timeout cleanup, and historical presentation replay', () => {
    expect(selection).toContain('const replayPresentFile = false');
    expect(selection).toContain('useFileStore.getState().setContextPanelOpen(false)');
    expect(selection).toContain('useSessionStore.getState().activeSessionId !== session.id');
    expect(selection).toContain('const timeoutId = setTimeout(() => controller.abort(), 10000)');
    expect(selection).toContain('setSessionLoading(false)');
  });

  it('aborts superseded cache refreshes during rapid session navigation', () => {
    expect(selection).toContain('const refreshControllerRef = useRef<AbortController | null>(null)');
    expect(selection).toContain('refreshControllerRef.current?.abort()');
    expect(selection).toContain('signal: refreshController.signal');
    expect(selection).toContain("error.name === 'AbortError'");
  });
});
