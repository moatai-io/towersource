import { describe, expect, it } from 'vitest';
import { resolveOperatorExecution } from './workbench-operator-execution.js';

const projectRoot = '/home/tower/workspace/projects/tower-project-dev';

function resolve(cwd: string, actorRole = 'admin') {
  return resolveOperatorExecution({
    request: { command: 'git status --short', cwd },
    actorRole,
    projectRoot,
  });
}

describe('Project execution environment boundary', () => {
  it('keeps ordinary Project execution on the Project plane', () => {
    expect(resolve('/workspace')).toMatchObject({ operatorPlane: false, credentialMode: 'required-only' });
    expect(resolve(`${projectRoot}/work`)).toMatchObject({
      operatorPlane: false,
      logicalCwd: '/workspace/work',
      request: { cwd: '/workspace/work' },
    });
  });

  it('does not expose an operator-plane Worker projection to privileged roles', () => {
    expect(() => resolve('/workspace/tower/packages/backend')).toThrow('OPERATOR_ACCESS_REQUIRED');
    expect(() => resolve('/workspace/workspace/projects/teamskills', 'operator')).toThrow('OPERATOR_ACCESS_REQUIRED');
  });

  it('requires Agent Operator access for host paths outside the current Project', () => {
    expect(() => resolve('/home/tower/tower', 'admin')).toThrow('PROJECT_CWD_OUTSIDE_WORKSPACE');
    expect(() => resolve('/home/tower/workspace/projects/teamskills', 'operator')).toThrow('PROJECT_CWD_OUTSIDE_WORKSPACE');
    expect(() => resolve('/etc', 'admin')).toThrow('PROJECT_CWD_OUTSIDE_WORKSPACE');
  });
});
