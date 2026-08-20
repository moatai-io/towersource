import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'AdminPanel.tsx'), 'utf8');

describe('Admin Agent-dedicated Connection boundary', () => {
  it('keeps dedicated credentials visible but disables cross-Agent connection', () => {
    expect(source).toContain("connectionScope?: 'shared' | 'agent_dedicated'");
    expect(source).toContain('dedicatedProjectId?: string | null');
    expect(source).toContain("selectedConnection.connectionScope === 'agent_dedicated'");
    expect(source).toContain("t('credentialConnections.dedicatedCredential')");
    expect(source).toContain("dedicatedElsewhere ? t('credentialConnections.agentDedicated')");
    expect(source).toContain('disabled={saving || !selectedConnection.enabled || dedicatedElsewhere}');
  });
});
