import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const GIT_GUIDE_PATH = path.resolve(import.meta.dirname, '../../../../docs/tower-guide/resources/git.md');

describe('Tower Git runtime guide single-tree contract', () => {
  it('does not recommend worktree creation as a multi-session isolation strategy', () => {
    const guide = fs.readFileSync(GIT_GUIDE_PATH, 'utf8');

    expect(guide).toContain('`git stash`와 새 worktree 생성 금지');
    expect(guide).toContain('모든 Tower 개발은 루트 working tree의 현재 `main`에서 수행');
    expect(guide).not.toContain('진짜 격리 필요 시 `git worktree add');
  });
});
