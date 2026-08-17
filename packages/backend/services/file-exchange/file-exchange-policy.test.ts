import { describe, expect, it } from 'vitest';
import { decideTransferPolicy } from './file-exchange-policy.js';

const personal = { scope: 'personal' as const, uri: 'personal://files/report.pdf' };

describe('File Exchange policy', () => {
  it('keeps a personal session attachment confirmation-free', () => {
    expect(decideTransferPolicy(personal, { scope: 'session', sessionId: 's1' })).toEqual({
      mode: 'snapshot', confirmationRequired: false, confirmationMessage: null,
    });
  });

  it('requires confirmation for channel sharing', () => {
    expect(decideTransferPolicy(personal, { scope: 'channel', channelId: 'c1' })).toMatchObject({
      mode: 'snapshot', confirmationRequired: true,
    });
  });

  it('requires confirmation for permanent project copy', () => {
    expect(decideTransferPolicy(personal, { scope: 'project', projectId: 'p1' })).toMatchObject({
      mode: 'workspace_copy', confirmationRequired: true,
    });
  });

  it('requires confirmation when saving a project result to Personal Space', () => {
    expect(decideTransferPolicy(
      { scope: 'project', projectId: 'p1', relativePath: 'final/report.pdf' },
      { scope: 'personal', relativeDirectory: 'files' },
    )).toEqual({
      mode: 'snapshot',
      confirmationRequired: true,
      confirmationMessage: '이 파일의 독립된 사본을 내 개인 자료함에 영구 저장합니다.',
    });
  });

  it('rejects personal-to-personal copies', () => {
    expect(() => decideTransferPolicy(personal, { scope: 'personal' })).toThrow('같은 개인 자료함');
  });

  it('rejects same-project internal moves', () => {
    expect(() => decideTransferPolicy(
      { scope: 'project', projectId: 'p1', relativePath: 'a.txt' },
      { scope: 'project', projectId: 'p1' },
    )).toThrow('같은 AI 팀원 작업공간');
  });
});
