// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { act } from 'react';

// `virtual:pwa-register` is a Vite virtual module that vitest cannot resolve
// on its own. We mock it BEFORE importing the hook so the import graph is
// happy. The returned function is captured via vi.hoisted so individual
// tests can assert on it (and so the mock survives the hoist that vi.mock
// performs at parse time).
const { updateSWMock, registerSWMock } = vi.hoisted(() => {
  const updateSWMock = vi.fn().mockResolvedValue(undefined);
  return {
    updateSWMock,
    registerSWMock: vi.fn(() => updateSWMock),
  };
});

vi.mock('virtual:pwa-register', () => ({
  registerSW: registerSWMock,
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
  registerSWMock.mockClear();
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

  it('registers the service worker exactly once on mount', () => {
    render(<Probe />);
    expect(registerSWMock).toHaveBeenCalledTimes(1);
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

  it('triggers SW apply the moment busy → idle while a deferred apply is queued', () => {
    useSettingsStore.setState({ updateAvailable: true, deferredUpdateRequested: true });
    useChatStore.setState({ isStreaming: true });
    render(<Probe />);
    expect(updateSWMock).not.toHaveBeenCalled();

    act(() => {
      useChatStore.setState({ isStreaming: false });
    });

    // The SW updater should have been called with `true` (reload after swap).
    expect(updateSWMock).toHaveBeenCalledTimes(1);
    expect(updateSWMock).toHaveBeenCalledWith(true);
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

  it('marks first-seen on initial config (no prior buildId in store)', () => {
    const c = captureCoord();
    const result = c.evaluateConfigPayload({ buildId: 'build-1' });
    expect(result).toEqual({ kind: 'first-seen', latestBuildId: 'build-1' });
    expect(useSettingsStore.getState().updateAvailable).toBe(false);
    expect(useSettingsStore.getState().latestBuildId).toBe('build-1');
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

  it('marks changed-busy and surfaces the banner when build differs while user is streaming', () => {
    useSettingsStore.setState({
      serverConfig: { version: '0.2.0', buildId: 'build-1', workspaceRoot: '', permissionMode: '', claudeExecutable: '' },
    });
    useChatStore.setState({ isStreaming: true });

    const c = captureCoord();
    const result = c.evaluateConfigPayload({ buildId: 'build-2' });

    expect(result).toEqual({ kind: 'changed-busy', latestBuildId: 'build-2' });
    expect(useSettingsStore.getState().updateAvailable).toBe(true);
    expect(useSettingsStore.getState().latestBuildId).toBe('build-2');
  });

  it('marks changed-available without reloading an idle healthy tab', () => {
    useSettingsStore.setState({
      serverConfig: { version: '0.2.0', buildId: 'build-1', workspaceRoot: '', permissionMode: '', claudeExecutable: '' },
    });
    const c = captureCoord();
    const result = c.evaluateConfigPayload({ buildId: 'build-2' });

    expect(result).toEqual({ kind: 'changed-available', latestBuildId: 'build-2' });
    expect(useSettingsStore.getState().updateAvailable).toBe(true);
    expect(useSettingsStore.getState().latestBuildId).toBe('build-2');
  });
});
