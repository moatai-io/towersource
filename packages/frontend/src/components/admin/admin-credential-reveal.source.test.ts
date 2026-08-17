import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(import.meta.dirname, 'AdminPanel.tsx'), 'utf8');

describe('Admin Credential management UX', () => {
  it('puts reveal, edit, and structure actions together for each Credential', () => {
    expect(source).toContain('Credential 관리');
    expect(source).toContain('원문 보기');
    expect(source).toContain('수정하기');
    expect(source).toContain('구조 보기');
    expect(source).toContain("purpose: 'admin_session_reveal'");
  });

  it('removes compare and Tower password step-up from the Credential screen', () => {
    expect(source).not.toContain('내 값과 비교');
    expect(source).not.toContain('현재 Tower 비밀번호');
    expect(source).not.toContain('credentialStepUpPassword');
    expect(source).not.toContain('credentialCandidate');
  });

  it('keeps temporary inline masking controls', () => {
    expect(source).toContain('원문 · 30초 후 자동 마스킹');
    expect(source).toContain('지금 가리기');
    expect(source).toContain('credentialRevealTarget?.credentialId === credential.id');
  });
});
