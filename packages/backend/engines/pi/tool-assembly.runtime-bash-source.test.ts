import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './tool-assembly.ts'), 'utf8');

describe('Project authority-routed bash assembly policy', () => {
  it('uses the current Agent switch and admin/operator role without extra server approval', () => {
    expect(source).toContain('export async function resolveOperatorHostAccess');
    expect(source).toContain('getProjectAgentRuntimeProfile(input.projectId)');
    expect(source).not.toContain('TOWER_PLATFORM_AGENT_PROJECT_IDS');
    expect(source).toContain("['admin', 'operator'].includes(input.userRole");
    expect(source).toContain('currentAgentAuthority?.authorityPolicy?.superuser === true');
    expect(source).toContain('const operatorHostAccess = await resolveOperatorHostAccess');
    expect(source).toContain('const hostBashEnabled = operatorHostAccess');
  });

  it('does not derive revocable Operator access execution authority from the immutable Session snapshot', () => {
    expect(source).not.toContain('agentProfile?.authorityPolicy?.superuser === true');
    expect(source).not.toContain('getSessionProjectAgentRuntimeProfile');
    expect(source).toContain('Operator access is a revocable execution authority');
  });

  it('lets current Operator access authority override an older restricted Session Harness', () => {
    expect(source).toContain("harness.source !== 'legacy-default' && !operatorHostAccess");
    expect(source).toContain('Disabling Operator access immediately restores that pinned Harness');
  });

  it('keeps ordinary Project Agents on the Worker execution plane without a duplicate bash', () => {
    expect(source).toContain('runtimeBoxEnabled && !operatorHostAccess');
    expect(source).toContain("hostBash=${hostBashEnabled ? 'enabled' : 'hidden-project-runtime'}");
  });
});
