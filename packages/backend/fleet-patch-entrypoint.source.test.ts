import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../scripts/fleet/fleet-patch', import.meta.url), 'utf8');

describe('Fleet patch canonical repository boundary', () => {
  it('does not inherit a stale Operator Session checkout for Fleet ancestry checks', () => {
    expect(source).toContain('TOWER_FLEET_UPGRADE_REPO_ROOT="$repo_root"');
    expect(source).toContain('TOWER_FLEET_RUN_REPO_ROOT="$repo_root"');
    expect(source).toContain('run_prepare');
    expect(source).toContain('run_rollout');
  });
});
