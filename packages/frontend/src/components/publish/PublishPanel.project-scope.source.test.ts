import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PublishPanel.tsx', import.meta.url), 'utf8');

describe('PublishPanel project-scoped sharing contract', () => {
  it('explains project-scoped discovery and link sharing', () => {
    expect(source).toContain('참여 중인 프로젝트의 산출물만 표시됩니다');
    expect(source).toContain('게시 링크를 가진 사람은 열 수 있으며 검색엔진에는 표시되지 않습니다');
    expect(source).toContain('링크 공유');
  });

  it('does not expose legacy access-tier filtering or editing controls', () => {
    expect(source).not.toContain('ALL_ACCESS_TIERS');
    expect(source).not.toContain('toggleAccessFilter');
    expect(source).not.toContain('onChangeAccess');
    expect(source).not.toContain('접근 권한 일괄 변경');
  });
});
