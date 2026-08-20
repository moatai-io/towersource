import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function AgentLifecycleManagement');
const end = source.indexOf('// ───── Users Tab ─────', start);
const lifecycleSource = source.slice(start, end);

describe('AdminPanel agent lifecycle locale routing', () => {
  it('routes lifecycle feedback and workstation actions through admin locale keys', () => {
    expect(lifecycleSource).toContain("t('agentLifecycle.errors.loadAgents')");
    expect(lifecycleSource).toContain("t('agentLifecycle.errors.previewPurge')");
    expect(lifecycleSource).toContain("t('agentLifecycle.errors.previewWorkstation')");
    expect(lifecycleSource).toContain("t('agentLifecycle.errors.verifyWorkstation')");
    expect(lifecycleSource).toContain("t('agentLifecycle.errors.applyWorkstation')");
    expect(lifecycleSource).toContain("t('agentLifecycle.errors.startPurge')");
    expect(lifecycleSource).toContain("t('agentLifecycle.workstationChangeTitle'");
    expect(lifecycleSource).toContain("t('agentLifecycle.verificationPassed')");
    expect(lifecycleSource).toContain("t('agentLifecycle.credentialImpact'");
  });

  it('preserves workstation and purge API contracts without direct Korean UI copy', () => {
    expect(lifecycleSource).toContain('/workstation-change/preview');
    expect(lifecycleSource).toContain('/workstation-change/smoke');
    expect(lifecycleSource).toContain('/workstation-change/apply');
    expect(lifecycleSource).toContain('/purge/preview');
    expect(lifecycleSource).toContain('/purge/apply');
    expect(lifecycleSource).toContain("deploymentId: 'production'");
    expect(lifecycleSource).not.toMatch(/[가-힣]/);
  });
});
