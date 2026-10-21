// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_WORKSPACE_LOCATION_EVENT,
  getAgentWorkspaceLocation,
  rememberAgentWorkspaceLocation,
} from './navigation-state';

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  });
});

describe('Agent Workspace navigation memory', () => {
  it('defaults to home', () => {
    expect(getAgentWorkspaceLocation('p1')).toBe('home');
  });

  it('remembers locations independently per Project', () => {
    rememberAgentWorkspaceLocation('p1', 'files');
    rememberAgentWorkspaceLocation('p2', 'work');

    expect(getAgentWorkspaceLocation('p1')).toBe('files');
    expect(getAgentWorkspaceLocation('p2')).toBe('work');
  });

  it('notifies an already-mounted Project Home about repeated navigation', () => {
    const listener = vi.fn();
    window.addEventListener(AGENT_WORKSPACE_LOCATION_EVENT, listener);

    rememberAgentWorkspaceLocation('p1', 'home');

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ projectId: 'p1', location: 'home' });
    window.removeEventListener(AGENT_WORKSPACE_LOCATION_EVENT, listener);
  });
});
