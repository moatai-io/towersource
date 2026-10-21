import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('administrator Agent environment wiring', () => {
  it('reads storage authority for the current deployment rather than production only', () => {
    const source = fs.readFileSync(new URL('./agent-purge-preview.ts', import.meta.url), 'utf8');
    expect(source).toContain('resolveProjectEnvironmentDeploymentId()');
    expect(source).toContain('listProjectWorkspaceAuthorities(deploymentId)');
    expect(source).toContain('pcb.deployment_id=$2');
    expect(source).toContain('classifyProjectEnvironment(authorities.get(row.id)?.storage_kind');
  });
  it('does not label an absent Worker binding as Runtime Box', () => {
    const source = fs.readFileSync(new URL('../../../frontend/src/components/admin/AdminPanel.tsx', import.meta.url), 'utf8');
    expect(source).toContain('agentLifecycle.environmentModes.${agent.executionEnvironment.mode}');
    expect(source).not.toContain("agent.workstation?.enabled ? agent.workstation.workerId : 'Runtime Box'");
  });
});
