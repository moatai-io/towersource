import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/components/admin/AdminPanel.tsx'), 'utf8');
const ko = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/locales/ko/admin.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/locales/en/admin.json'), 'utf8'));

describe('Admin Credential promotion confirmation', () => {
  it('requires a danger confirmation before promoting an Agent Credential to workspace scope', () => {
    const block = source.slice(source.indexOf('const promoteCredential = async'), source.indexOf('const deleteConnection = async'));
    expect(block).toContain('await confirm({');
    expect(block).toContain("credential.provider === 'google' && credential.kind === 'gws'");
    expect(block).toContain("credentialConnections.promoteGoogleConfirm");
    expect(block).toContain('danger: true');
    expect(block.indexOf('if (!approved) return;')).toBeLessThan(block.indexOf("method: 'POST'"));
  });

  it('warns that Google OAuth permissions become available to every Agent', () => {
    expect(ko.credentialConnections.promoteGoogleConfirm).toContain('모든 일반 에이전트');
    expect(ko.credentialConnections.promoteGoogleConfirm).toContain('메일·캘린더·드라이브');
    expect(en.credentialConnections.promoteGoogleConfirm).toContain('every ordinary Agent');
    expect(en.credentialConnections.promoteGoogleConfirm).toContain('Gmail, Calendar, and Drive');
  });
});
