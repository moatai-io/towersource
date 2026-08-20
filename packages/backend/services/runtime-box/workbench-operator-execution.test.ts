import { describe, expect, it } from 'vitest';
import { resolveOperatorExecution } from './workbench-operator-execution.js';

const projectRoot = '/home/tower/workspace/projects/tower-project-dev';

function resolve(cwd: string, actorRole = 'admin', env: NodeJS.ProcessEnv = {
  TOWER_OPERATOR_TOWER_SOURCE_ROOT: '/home/tower/tower',
  TOWER_OPERATOR_WORKSPACE_ROOT: '/home/tower/workspace',
}) {
  return resolveOperatorExecution({
    request: { command: 'git status --short', cwd },
    actorRole,
    projectRoot,
    env,
  });
}

describe('Admin Operator Workbench execution policy', () => {
  it('keeps ordinary Project execution on the Project plane', () => {
    expect(resolve('/workspace')).toMatchObject({ operatorPlane: false, credentialMode: 'required-only' });
    expect(resolve(`${projectRoot}/work`)).toMatchObject({
      operatorPlane: false,
      logicalCwd: '/workspace/work',
      request: { cwd: '/workspace/work' },
    });
  });

  it('routes explicit operator projection cwd through the Operator plane', () => {
    expect(resolve('/workspace/tower/packages/backend')).toMatchObject({
      operatorPlane: true,
      logicalCwd: '/workspace/tower/packages/backend',
      credentialMode: 'none',
    });
    expect(resolve('/workspace/workspace/projects/teamskills', 'operator')).toMatchObject({
      operatorPlane: true,
      logicalCwd: '/workspace/workspace/projects/teamskills',
    });
    expect(() => resolve('/workspace/tower', 'member')).toThrow('OPERATOR_PLANE_ROLE_REQUIRED');
  });

  it('routes an admin Tower source cwd through the Operator projection without Credentials', () => {
    expect(resolve('/home/tower/tower')).toMatchObject({
      operatorPlane: true,
      hostCwd: '/home/tower/tower',
      logicalCwd: '/workspace/tower',
      credentialMode: 'none',
      request: { cwd: '/workspace/tower' },
    });
  });

  it('derives operator roots from the actual server HOME when explicit roots are absent', () => {
    expect(resolve('/home/operator/tower/packages/backend', 'admin', { HOME: '/home/operator' })).toMatchObject({
      operatorPlane: true,
      logicalCwd: '/workspace/tower/packages/backend',
      request: { cwd: '/workspace/tower/packages/backend' },
    });
    expect(resolve('/home/operator/workspace/projects/teamskills', 'operator', { HOME: '/home/operator' })).toMatchObject({
      operatorPlane: true,
      logicalCwd: '/workspace/workspace/projects/teamskills',
    });
  });

  it('routes organization Project paths through the workspace projection', () => {
    expect(resolve('/home/tower/workspace/projects/teamskills')).toMatchObject({
      operatorPlane: true,
      logicalCwd: '/workspace/workspace/projects/teamskills',
      request: { cwd: '/workspace/workspace/projects/teamskills' },
    });
  });

  it('rejects cross-Project host cwd for ordinary members', () => {
    expect(() => resolve('/home/tower/tower', 'member')).toThrow('PROJECT_CWD_OUTSIDE_WORKSPACE');
  });

  it('rejects even admin paths outside the bounded operator roots', () => {
    expect(() => resolve('/etc', 'admin')).toThrow('OPERATOR_CWD_NOT_ALLOWLISTED');
  });
});
