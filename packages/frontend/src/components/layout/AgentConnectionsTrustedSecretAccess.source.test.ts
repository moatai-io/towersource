import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/components/layout/AgentConnectionsPanel.tsx'), 'utf8');

describe('Agent Connections trusted secret access UI', () => {
  it('allows an authorized user to reveal and hide one Connection value', () => {
    expect(source).toContain('/credentials/${encodeURIComponent(credentialId)}/reveal');
    expect(source).toContain("purpose: 'Agent Connections value review'");
    expect(source).toContain("t('connectionRevealValue')");
    expect(source).toContain("t('connectionHideValue')");
  });

  it('imports an accessible source Connection into the current Agent', () => {
    expect(source).toContain('/credentials/import-candidates');
    expect(source).toContain('/credentials/import');
    expect(source).toContain('sourceProjectId: candidate.projectId');
    expect(source).toContain('sourceCredentialId: candidate.credentialId');
  });
});
