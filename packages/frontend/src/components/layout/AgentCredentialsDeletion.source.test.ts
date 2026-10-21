import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/components/layout/AgentCredentialsModal.tsx'), 'utf8');
const ko = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/locales/ko/layout.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/locales/en/layout.json'), 'utf8'));

describe('Agent-dedicated Connection deletion UI', () => {
  it('requires a danger confirmation before deleting the exact Agent Credential', () => {
    expect(source).toContain("import { useConfirm } from '../../hooks/useDialog'");
    expect(source).toContain("title: t('agentCredentials.deleteConfirmTitle')");
    expect(source).toContain("message: t('agentCredentials.deleteConfirmMessage', { name: credential.display_name })");
    expect(source).toContain('danger: true');
    expect(source).toContain("method: 'DELETE'");
    expect(source).toContain('/projects/${encodeURIComponent(project.id)}/credentials/${encodeURIComponent(credential.id)}');
  });

  it('puts lifecycle management first and avoids duplicate dedicated cards', () => {
    expect(source.indexOf("t('agentCredentials.listTitle')")).toBeLessThan(source.indexOf('<AgentConnectionsPanel'));
    expect(source).toContain('spacious hideAgentConnections');
    expect(source).toContain("method: 'PATCH'");
    expect(source).not.toContain('/connection`');
    expect(ko.agentCredentials.listTitle).toBe('이 에이전트 전용');
  });
});
