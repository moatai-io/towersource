// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { act } from 'react';

// `virtual:pwa-register` is a Vite virtual module that vitest cannot resolve
// on its own. We mock it BEFORE importing the hook so the import graph is
// happy. The returned function is captured via vi.hoisted so individual
// tests can assert on it (and so the mock survives the hoist that vi.mock
// performs at parse time).
const { updateSWMock, registerSWMock, isAllowedDevHostMock, reloadForUserUpdateMock } = vi.hoisted(() => {
  const updateSWMock = vi.fn().mockResolvedValue(undefined);
  return {
    updateSWMock,
    reloadForUserUpdateMock: vi.fn().mockResolvedValue(undefined),
    registerSWMock: vi.fn((_options: { onNeedRefresh: () => void }) => updateSWMock),
    isAllowedDevHostMock: vi.fn(() => false),
  };
});

vi.mock('virtual:pwa-register', () => ({
  registerSW: registerSWMock,
}));

vi.mock('../config/dev-hosts', () => ({
  isAllowedDevHost: isAllowedDevHostMock,
}));

vi.mock('../utils/app-version', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/app-version')>(),
  reloadForUserUpdate: reloadForUserUpdateMock,
}));

import { useAppUpdateCoordinator } from './useAppUpdateCoordinator';
import { useSettingsStore } from '../stores/settings-store';
import { useChatStore } from '../stores/chat-store';

function resetStores() {
  useSettingsStore.setState({
    updateAvailable: false,
    latestBuildId: null,
    deferredUpdateRequested: false,
    serverConfig: null,
  });
  useChatStore.setState({
    isStreaming: false,
    pendingQuestion: null,
    messageQueue: {},
  });
}

beforeEach(() => {
  resetStores();
  updateSWMock.mockClear();
  reloadForUserUpdateMock.mockClear();
  registerSWMock.mockClear();
  isAllowedDevHostMock.mockReset();
  isAllowedDevHostMock.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Probe component that exercises the hook and exposes the result via DOM
 * attributes. We use data-* on a single node so assertions are explicit
 * and the rendered tree is small enough to keep tests fast.
 */
function Probe({ onCoord }: { onCoord?: (c: ReturnType<typeof useAppUpdateCoordinator>) => void }) {
  const c = useAppUpdateCoordinator();
  onCoord?.(c);
  return (
    <div
      data-testid="probe"
      data-update-available={String(c.updateAvailable)}
      data-deferred={String(c.deferredUpdateRequested)}
      data-busy={String(c.isBusyForReload)}
    />
  );
}

describe('useAppUpdateCoordinator — smoke', () => {
  it('renders on first mount without throwing (regression: TDZ on update vars)', () => {
    // This is the test that, had it existed last week, would have caught the
    // ReferenceError on App.tsx that crashed the whole frontend. The hook MUST
    // be safe to instantiate from a cold mount with default store state.
    expect(() => render(<Probe />)).not.toThrow();
    const probe = screen.getByTestId('probe');
    expect(probe).toHaveAttribute('data-update-available', 'false');
    expect(probe).toHaveAttribute('data-deferred', 'false');
    expect(probe).toHaveAttribute('data-busy', 'false');
  });

  it('registers the service worker exactly once on a deployed host', () => {
    render(<Probe />);
    expect(registerSWMock).toHaveBeenCalledTimes(1);
  });

  it('does not register a service worker on a development host', () => {
    isAllowedDevHostMock.mockReturnValue(true);
    render(<Probe />);
    expect(registerSWMock).not.toHaveBeenCalled();
  });
});

describe('useAppUpdateCoordinator — build detection', () => {
  function configureCurrentBuild(buildId = 'build-1') {
    useSettingsStore.setState({
      serverConfig: { version: '0.2.0', buildId, workspaceRoot: '', permissionMode: '', claudeExecutable: '' },
    });
  }

  function healthResponse(buildId: string) {
    return { ok: true, json: async () => ({ buildId }) } as Response;
  }

  it('does not poll build ids on a development host', async () => {
    isAllowedDevHostMock.mockReturnValue(true);
    configureCurrentBuild();
    const fetchMock = vi.fn().mockResolvedValue(healthResponse('build-2'));
    vi.stubGlobal('fetch', fetchMock);

    render(<Probe />);
    await act(async () => { await Promise.resolve(); });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().updateAvailable).toBe(false);
  });

  it('does not show an update for a backend restart of the same frontend revision', async () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'same-source');
    configureCurrentBuild('old-boot');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ buildId: 'new-boot', sourceRev: 'same-source' }) }));

    render(<Probe />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(useSettingsStore.getState().updateAvailable).toBe(false);
  });

  it('does not infer an update from a boot id alone when source revision is unavailable', async () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'running-source');
    configureCurrentBuild('old-boot');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse('new-boot')));

    render(<Probe />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(useSettingsStore.getState().updateAvailable).toBe(false);
  });

  it('detects a stale frontend even when config and health share the same backend build id', async () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    configureCurrentBuild('build-2');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ buildId: 'build-2', sourceRev: 'new-source' }) }));
    render(<Probe />);
    await waitFor(() => expect(useSettingsStore.getState().updateAvailable).toBe(true));
    expect(useSettingsStore.getState().latestBuildId).toBe('build-2');
  });

  it('checks for a newer frontend revision on mount and surfaces the banner', async () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    configureCurrentBuild();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ buildId: 'build-2', sourceRev: 'new-source' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<Probe />);

    await waitFor(() => expect(useSettingsStore.getState().updateAvailable).toBe(true));
    expect(useSettingsStore.getState().latestBuildId).toBe('build-2');
    expect(fetchMock).toHaveBeenCalledWith('/api/health', { cache: 'no-store' });
  });

  it('checks again when the window regains focus', async () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    configureCurrentBuild();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: 'build-1', sourceRev: 'old-source' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: 'build-2', sourceRev: 'new-source' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<Probe />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(useSettingsStore.getState().updateAvailable).toBe(true);
  });

  it('polls while visible and clears the interval on unmount', async () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    vi.useFakeTimers();
    configureCurrentBuild();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: 'build-1', sourceRev: 'old-source' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: 'build-2', sourceRev: 'new-source' }) });
    vi.stubGlobal('fetch', fetchMock);
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const view = render(<Probe />);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().updateAvailable).toBe(true);

    view.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    clearIntervalSpy.mockRestore();
  });

  it('clears a stale banner when health confirms the executing frontend is current', async () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'current-source');
    useSettingsStore.setState({ updateAvailable: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ buildId: 'new-boot', sourceRev: 'current-source' }) }));
    render(<Probe />);
    await waitFor(() => expect(useSettingsStore.getState().updateAvailable).toBe(false));
  });

  it('ignores a health response that resolves after unmount', async () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    let resolveHealth: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveHealth = resolve; })));
    const view = render(<Probe />);
    view.unmount();
    await act(async () => {
      resolveHealth?.({ ok: true, json: async () => ({ buildId: 'build-2', sourceRev: 'new-source' }) } as Response);
    });
    expect(useSettingsStore.getState().updateAvailable).toBe(false);
  });

  it('does not overlap health checks or repeat the same detected build', async () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    configureCurrentBuild();
    let resolveHealth: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveHealth = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Probe />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveHealth?.({ ok: true, json: async () => ({ buildId: 'build-2', sourceRev: 'new-source' }) } as Response);
      await Promise.resolve();
    });
    expect(useSettingsStore.getState().latestBuildId).toBe('build-2');

    const setUpdateAvailableSpy = vi.spyOn(useSettingsStore.getState(), 'setUpdateAvailable');
    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => {
      resolveHealth?.({ ok: true, json: async () => ({ buildId: 'build-2', sourceRev: 'new-source' }) } as Response);
      await Promise.resolve();
    });
    expect(setUpdateAvailableSpy).not.toHaveBeenCalled();
    setUpdateAvailableSpy.mockRestore();
  });
});

describe('useAppUpdateCoordinator — busy reflection', () => {
  it('reflects isStreaming as busy', () => {
    useChatStore.setState({ isStreaming: true });
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveAttribute('data-busy', 'true');
  });

  it('reflects messageQueue length as busy', () => {
    useChatStore.setState({ messageQueue: { 'sess-1': ['queued'] } });
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveAttribute('data-busy', 'true');
  });
});

describe('useAppUpdateCoordinator — deferred apply on idle', () => {
  it('does NOT trigger SW apply while user is busy', () => {
    useSettingsStore.setState({ updateAvailable: true, deferredUpdateRequested: true });
    useChatStore.setState({ isStreaming: true });
    render(<Probe />);
    expect(updateSWMock).not.toHaveBeenCalled();
  });

  it('navigates the moment busy → idle while a deferred apply is queued', () => {
    useSettingsStore.setState({ updateAvailable: true, deferredUpdateRequested: true });
    useChatStore.setState({ isStreaming: true });
    render(<Probe />);
    expect(updateSWMock).not.toHaveBeenCalled();

    act(() => {
      useChatStore.setState({ isStreaming: false });
    });

    expect(reloadForUserUpdateMock).toHaveBeenCalledTimes(1);
    expect(updateSWMock).not.toHaveBeenCalled();
  });

  it('does not trigger SW apply when only updateAvailable is set (no defer)', () => {
    useSettingsStore.setState({ updateAvailable: true, deferredUpdateRequested: false });
    render(<Probe />);
    expect(updateSWMock).not.toHaveBeenCalled();
  });
});

describe('useAppUpdateCoordinator — evaluateConfigPayload', () => {
  function captureCoord() {
    const ref: { current: ReturnType<typeof useAppUpdateCoordinator> | null } = { current: null };
    render(<Probe onCoord={(c) => { ref.current = c; }} />);
    if (!ref.current) throw new Error('coordinator was not captured');
    return ref.current;
  }

  it('returns null for null payload', () => {
    const c = captureCoord();
    expect(c.evaluateConfigPayload(null)).toBeNull();
  });

  it('shows the update on first config when the running frontend source differs', () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    const c = captureCoord();
    c.evaluateConfigPayload({ buildId: 'build-2', sourceRev: 'new-source' });
    expect(useSettingsStore.getState().updateAvailable).toBe(true);
    expect(useSettingsStore.getState().latestBuildId).toBe('build-2');
  });

  it('uses forced navigation instead of the service worker when frontend source is stale', () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    useSettingsStore.setState({ updateAvailable: true, serverConfig: { version: '0.2.0', buildId: 'build-2', sourceRev: 'new-source', workspaceRoot: '', permissionMode: '', claudeExecutable: '' } });
    const c = captureCoord();
    c.requestReload();
    expect(reloadForUserUpdateMock).toHaveBeenCalledTimes(1);
    expect(updateSWMock).not.toHaveBeenCalled();
  });

  it('does not surface an update on initial config without a source mismatch', () => {
    const c = captureCoord();
    const result = c.evaluateConfigPayload({ buildId: 'build-1' });
    expect(result).toEqual({ kind: 'no-change', latestBuildId: 'build-1' });
    expect(useSettingsStore.getState().updateAvailable).toBe(false);
    expect(useSettingsStore.getState().latestBuildId).toBe('build-1');
  });

  it('does not show the banner for a different boot id when the frontend revision matches', () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'same-source');
    useSettingsStore.setState({
      serverConfig: { version: '0.2.0', buildId: 'old-boot', sourceRev: 'same-source', workspaceRoot: '', permissionMode: '', claudeExecutable: '' },
    });
    const c = captureCoord();
    const result = c.evaluateConfigPayload({ buildId: 'new-boot', sourceRev: 'same-source' });
    expect(result?.kind).toBe('no-change');
    expect(useSettingsStore.getState().updateAvailable).toBe(false);
  });

  it('keeps a real SW update visible when config has the same frontend source', () => {
    const c = captureCoord();
    act(() => registerSWMock.mock.calls[0][0].onNeedRefresh());
    act(() => { c.evaluateConfigPayload({ buildId: 'build-1' }); });
    expect(useSettingsStore.getState().updateAvailable).toBe(true);
  });

  it('navigates for a health-detected update even when config is still from the old backend', () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    useSettingsStore.setState({ updateAvailable: true, serverConfig: { version: '0.2.0', buildId: 'build-1', sourceRev: 'old-source', workspaceRoot: '', permissionMode: '', claudeExecutable: '' } });
    const c = captureCoord();
    c.requestReload();
    expect(reloadForUserUpdateMock).toHaveBeenCalledTimes(1);
    expect(updateSWMock).not.toHaveBeenCalled();
  });

  it('marks no-change when buildIds match', () => {
    useSettingsStore.setState({
      serverConfig: { version: '0.2.0', buildId: 'build-1', workspaceRoot: '', permissionMode: '', claudeExecutable: '' },
    });
    const c = captureCoord();
    const result = c.evaluateConfigPayload({ buildId: 'build-1' });
    expect(result?.kind).toBe('no-change');
    expect(useSettingsStore.getState().updateAvailable).toBe(false);
  });

  it('reports changed-busy for a source mismatch without interrupting streaming', () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    useChatStore.setState({ isStreaming: true });
    const c = captureCoord();
    const result = c.evaluateConfigPayload({ buildId: 'build-2', sourceRev: 'new-source' });
    expect(result).toEqual({ kind: 'changed-busy', latestBuildId: 'build-2' });
    expect(useSettingsStore.getState().updateAvailable).toBe(true);
    expect(reloadForUserUpdateMock).not.toHaveBeenCalled();
  });

  it('does not show the banner from boot-id changes alone while streaming', () => {
    useSettingsStore.setState({
      serverConfig: { version: '0.2.0', buildId: 'build-1', workspaceRoot: '', permissionMode: '', claudeExecutable: '' },
    });
    useChatStore.setState({ isStreaming: true });

    const c = captureCoord();
    const result = c.evaluateConfigPayload({ buildId: 'build-2' });

    expect(result).toEqual({ kind: 'no-change', latestBuildId: 'build-2' });
    expect(useSettingsStore.getState().updateAvailable).toBe(false);
    expect(useSettingsStore.getState().latestBuildId).toBe('build-2');
  });

  it('marks changed-available without reloading an idle healthy tab', () => {
    vi.stubGlobal('__TOWER_FRONTEND_SOURCE_REV__', 'old-source');
    useSettingsStore.setState({
      serverConfig: { version: '0.2.0', buildId: 'build-1', workspaceRoot: '', permissionMode: '', claudeExecutable: '' },
    });
    const c = captureCoord();
    const result = c.evaluateConfigPayload({ buildId: 'build-2', sourceRev: 'new-source' });

    expect(result).toEqual({ kind: 'changed-available', latestBuildId: 'build-2' });
    expect(useSettingsStore.getState().updateAvailable).toBe(true);
    expect(useSettingsStore.getState().latestBuildId).toBe('build-2');
  });
});
