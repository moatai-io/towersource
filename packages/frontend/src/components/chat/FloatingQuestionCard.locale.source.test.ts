import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'FloatingQuestionCard.tsx'), 'utf8');

describe('FloatingQuestionCard locale contract', () => {
  it('routes inferred confirmation options and minimized question chrome through chat locale keys', () => {
    for (const key of [
      'confirmProceed',
      'confirmStop',
      'unanswered',
      'expandQuestion',
      'questionNeedsAnswer',
      'reopenQuestion',
      'minimizeQuestion',
    ]) expect(source).toContain(key);
  });

  it('preserves Korean and English go/no-go intent recognition', () => {
    expect(source).toContain('네|예|아니오|yes|no');
    expect(source).toContain('승인|확인|진행|계속|실행|반영|삭제|배포|재시작');
    expect(source).toContain('approve|confirm|proceed|continue|run|deploy|restart');
  });
});
