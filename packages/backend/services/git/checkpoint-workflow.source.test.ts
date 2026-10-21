import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const checkpoint = fs.readFileSync(path.join(root, 'scripts/git/checkpoint.mjs'), 'utf8');
const skill = fs.readFileSync(path.join(root, 'skills/system/checkpoint/SKILL.md'), 'utf8');
const alias = fs.readFileSync(path.join(root, 'skills/system/commit-session/SKILL.md'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

describe('shared development checkpoint workflow', () => {
  it('commits the reviewed complete dirty state only when the validation fingerprint still matches', () => {
    expect(checkpoint).toContain("git', ['status', '--porcelain=v1', '--untracked-files=all']");
    expect(checkpoint).toContain("git', ['add', '-A', '--']");
    expect(checkpoint).toContain('state.fingerprint !== options.expectedFingerprint');
    expect(checkpoint).toContain('Tower-Session: ${options.sessionId}');
    expect(checkpoint).not.toContain('session_file_edits');
  });

  it('blocks common secret, runtime, generated, and stale-worktree inputs', () => {
    expect(checkpoint).toContain('/(^|\\/)\\.env(?:\\.|$)/i');
    expect(checkpoint).toContain('node_modules|dist|coverage|\\.worktrees|\\.git');
    expect(checkpoint).toContain('untracked secret-like filename');
    expect(checkpoint).toContain('untracked file exceeds');
  });

  it('separates complete-tree checkpoints from ledger-backed session commits', () => {
    expect(skill).toContain('name: checkpoint');
    expect(skill).toContain('검토된 전체 dirty 상태');
    expect(skill).toContain('이번 Session이나 특정 hotfix 파일만 저장하려면 `/commit-session`');
    expect(alias).toContain('name: commit-session');
    expect(alias).toContain('Durable File Ledger');
    expect(alias).toContain('git add -- <paths...>');
    expect(alias).not.toContain('compatibility alias');
  });

  it('runs clean CI on pull requests and includes deployment contracts', () => {
    expect(ci).toContain('pull_request:');
    expect(ci).toContain('node scripts/run-deploy-contract-tests.mjs');
  });
});
