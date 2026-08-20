import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(import.meta.dirname, 'AdminPanel.tsx'), 'utf8');

describe('Admin Credential management UX', () => {
  it('puts reveal, edit, and structure actions together for each Credential', () => {
    expect(source).toContain("t('credentialConnections.advancedCredentialManagement')");
    expect(source).toContain("t('credentialConnections.advancedActions.reveal')");
    expect(source).toContain("t('credentialConnections.advancedActions.edit')");
    expect(source).toContain("t('credentialConnections.advancedActions.inspect')");
    expect(source).toContain("purpose: 'admin_session_reveal'");
  });

  it('removes compare and Tower password step-up from the Credential screen', () => {
    expect(source).not.toContain('내 값과 비교');
    expect(source).not.toContain('현재 Tower 비밀번호');
    expect(source).not.toContain('credentialStepUpPassword');
    expect(source).not.toContain('credentialCandidate');
  });

  it('keeps temporary inline masking controls', () => {
    expect(source).toContain("t('credentialConnections.advancedMessages.revealExpiry')");
    expect(source).toContain("t('credentialConnections.advancedActions.maskNow')");
    expect(source).toContain('credentialRevealTarget?.credentialId === credential.id');
  });
});
