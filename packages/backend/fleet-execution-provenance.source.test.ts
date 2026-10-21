import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const start = readFileSync(new URL('../../start.sh', import.meta.url), 'utf8');
const run = readFileSync(new URL('../../scripts/fleet/fleet-deploy-run', import.meta.url), 'utf8');
const upgrade = readFileSync(new URL('../../scripts/fleet/upgrade-fleet-production', import.meta.url), 'utf8');

describe('Fleet execution source and provenance guards', () => {
  it('pins official start.sh Fleet entrypoints to the invoked canonical checkout', () => {
    expect(start).toContain('run_canonical_fleet()');
    expect(start).toContain('TOWER_FLEET_RUN_REPO_ROOT="$repo_root"');
    expect(start).toContain('TOWER_FLEET_UPGRADE_REPO_ROOT="$repo_root"');
    expect(start).toContain('run_canonical_fleet bash scripts/fleet/fleet-deploy-run "$@"');
    expect(start).toContain('run_canonical_fleet bash scripts/fleet/upgrade-fleet-production apply "$@"');
  });

  it('keeps direct script execution fail-closed on mismatched repo roots', () => {
    expect(run).toContain('TOWER_FLEET_RUN_REPO_ROOT must match the invoked checkout');
    expect(run).toContain('[[ "$repo_root" = "$script_root" ]]');
    expect(upgrade).toContain('TOWER_FLEET_UPGRADE_REPO_ROOT must match the invoked checkout');
    expect(upgrade).toContain('[[ "$repo_root" = "$script_root" ]]');
  });

  it('allocates collision-resistant run directories atomically', () => {
    expect(run).toContain('allocate_run_dir()');
    expect(run).toContain('%Y%m%dT%H%M%S%NZ');
    expect(run).toContain('-$$-$attempt');
    expect(run).toContain('if mkdir "$run_dir" 2>/dev/null');
    expect(run).not.toContain('run_id="$(new_id "$rev")"');
  });

  it('records execution and registry provenance in every request', () => {
    expect(run).toContain("'execution':{'scriptPath':execution_script,'repoRoot':repo_root,'gitRevision':execution_rev}");
    expect(run).toContain("'registry':{'path':registry,'sha256':registry_sha256,'gitRevision':registry_rev or None}");
    expect(run).toContain('execution_rev="$(git -C "$repo_root" rev-parse HEAD)"');
    expect(run).toContain('registry_sha256="$(sha256sum "$registry"');
  });

  it('keeps provenance secret-free and structured', () => {
    const fixture = {
      execution: { scriptPath: '/example/scripts/fleet/fleet-deploy-run', repoRoot: '/example', gitRevision: 'a'.repeat(40) },
      registry: { path: '/example/records/customer-vms.yaml', sha256: 'b'.repeat(64), gitRevision: 'c'.repeat(40) },
    };
    const dir = mkdtempSync(join(tmpdir(), 'fleet-provenance-'));
    const path = join(dir, 'request.json');
    writeFileSync(path, `${JSON.stringify(fixture)}\n`);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.execution.gitRevision).toHaveLength(40);
    expect(parsed.registry.sha256).toHaveLength(64);
    expect(JSON.stringify(parsed)).not.toMatch(/token|password|secret/i);
  });
});
