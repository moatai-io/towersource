import { describe, expect, it } from 'vitest';
import { resolveReleaseMetadata } from './pkg-info.js';

const fixedNow = () => new Date('2026-07-16T00:00:00.000Z');
const pkg = { name: 'tower', version: '1.70.29' };

function noGitExec(): string {
  throw new Error('not a git checkout');
}

describe('resolveReleaseMetadata', () => {
  it('prefers fresh Git metadata over inherited environment values', () => {
    const commands: Record<string, string> = {
      'git rev-parse HEAD': '535bd1cf793cdce58ab3b218b100758c6d6ac147',
      "git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname": 'v1.70.42\nv1.70.41',
      'git rev-list v1.70.42..HEAD --count': '0',
    };
    const result = resolveReleaseMetadata({
      env: {
        TOWER_VERSION: 'stale',
        TOWER_BASE_VERSION: 'stale',
        GIT_SHA: 'aaaaaaaaaaaa',
        SOURCE_REV: 'aaaaaaaaaaaaaaaa',
      },
      exec: (command) => commands[command],
      packageInfo: pkg,
      now: fixedNow,
    });

    expect(result).toMatchObject({
      version: '1.70.42',
      baseVersion: '1.70.42',
      commitsSinceTag: 0,
      gitSha: '535bd1cf793c',
      sourceRev: '535bd1cf793cdce58ab3b218b100758c6d6ac147',
      metadataSource: 'git',
    });
  });

  it('uses the complete injected contract in a no-Git packaged runtime', () => {
    const result = resolveReleaseMetadata({
      env: {
        TOWER_VERSION: '1.70.42',
        TOWER_BASE_VERSION: '1.70.42',
        TOWER_COMMITS_SINCE_TAG: '0',
        GIT_SHA: '535bd1cf793cdce58ab3b218b100758c6d6ac147',
        SOURCE_REV: '535bd1cf793cdce58ab3b218b100758c6d6ac147',
        BUILD_TIME: '2026-07-16T00:00:00.000Z',
        FLAKE_LOCK_NAR_HASH: 'sha256-example',
      },
      exec: noGitExec,
      packageInfo: pkg,
      now: fixedNow,
    });

    expect(result).toEqual({
      version: '1.70.42',
      baseVersion: '1.70.42',
      commitsSinceTag: 0,
      gitSha: '535bd1cf793c',
      buildTime: '2026-07-16T00:00:00.000Z',
      sourceRev: '535bd1cf793cdce58ab3b218b100758c6d6ac147',
      flakeLockNarHash: 'sha256-example',
      metadataSource: 'injected',
    });
  });

  it('forces packaged release metadata even when runtime cwd is a Git checkout', () => {
    const calls: string[] = [];
    const result = resolveReleaseMetadata({
      env: {
        TOWER_PACKAGED_RELEASE: 'true',
        TOWER_VERSION: '1.70.43',
        TOWER_BASE_VERSION: '1.70.43',
        GIT_SHA: 'abc123def456',
        SOURCE_REV: 'abc123def4567890',
      },
      cwd: '/external/runtime-cwd',
      exec: (command) => { calls.push(command); return 'unexpected-live-git-value'; },
      packageInfo: pkg,
      now: fixedNow,
    });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      version: '1.70.43',
      gitSha: 'abc123def456',
      sourceRev: 'abc123def4567890',
      metadataSource: 'injected',
    });
  });

  it('fails closed when packaged metadata is only partially injected', () => {
    expect(() => resolveReleaseMetadata({
      env: { TOWER_VERSION: '1.70.42', GIT_SHA: '535bd1cf793c' },
      exec: noGitExec,
      packageInfo: pkg,
      now: fixedNow,
    })).toThrow('Incomplete packaged release metadata: missing baseVersion, sourceRev');
  });

  it('keeps package.json as the compatibility fallback when no contract is supplied', () => {
    expect(resolveReleaseMetadata({
      env: {},
      exec: noGitExec,
      packageInfo: pkg,
      now: fixedNow,
    })).toEqual({
      version: '1.70.29',
      baseVersion: '1.70.29',
      commitsSinceTag: null,
      gitSha: null,
      buildTime: '2026-07-16T00:00:00.000Z',
      sourceRev: null,
      flakeLockNarHash: null,
      metadataSource: 'package',
    });
  });

  it('synthesizes commits-since-tag only from Git checkout evidence', () => {
    const commands: Record<string, string> = {
      'git rev-parse HEAD': 'abcdef1234567890',
      "git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname": 'v1.70.42',
      'git rev-list v1.70.42..HEAD --count': '3',
    };
    expect(resolveReleaseMetadata({
      env: {},
      exec: (command) => commands[command],
      packageInfo: pkg,
      now: fixedNow,
    }).version).toBe('1.70.42+3');
  });
});
