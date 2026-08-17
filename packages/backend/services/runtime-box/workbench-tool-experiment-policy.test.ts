import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertExperimentalWorkbenchToolAccess, isExperimentalUnifiedShellVisible } from './workbench-tool-experiment-policy.js';
import { clearCurrentRootTurn, setCurrentRootTurn } from '../agent-turn/current-root-turn.js';

const allow = () => {
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'true');
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS', JSON.stringify(['project-a']));
};

afterEach(() => { vi.unstubAllEnvs(); clearCurrentRootTurn('session-a'); });

describe('experimental Workbench tool access', () => {
  it('is disabled by default and fails closed on malformed or empty allowlists', () => {
    vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'false');
    vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS', '[]');
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-a', role: 'admin' })).toThrowError(expect.objectContaining({ code: 'EXPERIMENT_DISABLED' }));
    vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'true');
    vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS', 'not-json');
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-a', role: 'admin' })).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_ALLOWLISTED' }));
  });

  it('rejects the existing automatic recovery execution signal', () => {
    allow();
    setCurrentRootTurn('session-a', 'turn-a', true);
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-a', role: 'admin', sessionId: 'session-a' }))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_EXECUTION_REFUSED' }));
  });

  it('opens ordinary Unified Shell work to enabled members without broadening mutation authority', () => {
    allow();
    expect(isExperimentalUnifiedShellVisible({ projectId: 'project-a', role: 'admin' })).toBe(true);
    expect(isExperimentalUnifiedShellVisible({ projectId: 'project-a', role: 'operator' })).toBe(true);
    expect(isExperimentalUnifiedShellVisible({ projectId: 'project-a', role: 'member' })).toBe(true);
    expect(isExperimentalUnifiedShellVisible({ projectId: 'project-a', role: 'customer_manager' })).toBe(false);
    expect(isExperimentalUnifiedShellVisible({ projectId: 'project-b', role: 'member' })).toBe(false);
  });

  it('lets explicit DB rollout decisions override the env allowlist', () => {
    allow();
    expect(isExperimentalUnifiedShellVisible({ projectId: 'project-a', role: 'member', rolloutEnabled: false })).toBe(false);
    expect(isExperimentalUnifiedShellVisible({ projectId: 'project-b', role: 'member', rolloutEnabled: true })).toBe(true);
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-a', role: 'admin', rolloutEnabled: false }))
      .toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_ALLOWLISTED' }));
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-b', role: 'operator', rolloutEnabled: true })).not.toThrow();
  });

  it('keeps persistent mutation and Runtime recovery limited to admin/operator', () => {
    allow();
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-a', role: 'admin' })).not.toThrow();
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-a', role: 'operator' })).not.toThrow();
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-a', role: 'member' })).toThrowError(expect.objectContaining({ code: 'MUTATION_ROLE_REQUIRED' }));
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-a', role: 'customer_manager' })).toThrowError(expect.objectContaining({ code: 'MUTATION_ROLE_REQUIRED' }));
    expect(() => assertExperimentalWorkbenchToolAccess({ projectId: 'project-b', role: 'admin' })).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_ALLOWLISTED' }));
  });
});
