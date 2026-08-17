import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const verifier = read('scripts/git/pre-push-verified-state');
const materializer = read('scripts/git/materialize-committed-source');
const installer = read('scripts/git/install-pre-push-hook');

describe('pushed-state preflight attestation cache source contract', () => {
  it('keys successful evidence by immutable commit and validation environment', () => {
    expect(verifier).toContain('cache_key="${local_sha}-${inputs_hash}"');
    expect(verifier).toContain('TOWER_PREPUSH_NODE_BIN');
    expect(verifier).toContain('TOWER_PREPUSH_NPM_BIN');
    expect(verifier).toContain('node_identity="${node_bin:-missing}|$node_version"');
    expect(verifier).toContain('npm_identity="${npm_bin:-missing}|$npm_version"');
    expect(verifier).toContain('TOWER_PREPUSH_PYTHON_BIN:-/usr/bin/python3');
    expect(verifier).toContain("('fitz','ezdxf')");
    expect(verifier).toContain('package-lock.json');
    expect(verifier).toContain('tsconfig.backend.json');
    expect(verifier).toContain('scripts/check-pi-tool-context-contracts.mjs');
  });

  it('trusts only passed attestations whose SHA and fingerprint match exactly', () => {
    expect(verifier).toContain("assert x.get('status')=='passed'");
    expect(verifier).toContain("assert x.get('sha')==sys.argv[2]");
    expect(verifier).toContain("assert x.get('fingerprint')==sys.argv[3]");
    expect(verifier).toContain('TOWER_PREPUSH_FORCE_FULL');
  });

  it('exposes read-only exact-SHA attestation verification for deployment gates', () => {
    expect(verifier).toContain('verify-attestation');
    expect(verifier).toContain('no valid passed attestation for $local_sha');
    expect(verifier).toContain("'status':'passed'");
    expect(verifier).toContain('"sha":"%s"');
  });

  it('runs the full preflight from an exact archive snapshot with owned dependencies', () => {
    expect(verifier).toContain('TOWER_PREPUSH_SNAPSHOT_ROOT');
    expect(verifier).toContain('${TMPDIR:-/tmp}/tower-prepush-snapshots');
    expect(verifier).not.toContain('snapshot_root="${TOWER_PREPUSH_SNAPSHOT_ROOT:-$cache_root/runs}"');
    expect(verifier).toContain('snapshotRoot=%s');
    expect(verifier).toContain('scripts/git/materialize-committed-source');
    expect(verifier).toContain('TOWER_PREPUSH_COMMAND:-npm ci && npm run preflight');
    expect(verifier).toContain('TOWER_PREPUSH_VITEST_MAX_WORKERS:-4');
    expect(verifier).toContain('VITEST_MAX_WORKERS="$vitest_max_workers"');
    expect(verifier).toContain('commit snapshot has no dependencies');
    expect(verifier).not.toContain('git -C "$root" worktree add');
    expect(verifier).not.toContain('git -C "$root" worktree remove');
    expect(verifier).not.toContain('git -C "$root" worktree prune');
    expect(verifier).not.toContain('ln -sfn "$root/node_modules"');
    expect(verifier).toContain('TOWER_SOURCE_SHA="$local_sha"');
    expect(verifier).toContain('PATH="$(dirname "$python_bin"):$PATH" timeout "$hook_timeout" bash -c "$preflight_cmd"');
    expect(verifier).not.toContain('--no-verify');
  });

  it('materializes only tracked files from the exact commit without Git checkout state', () => {
    expect(materializer).toContain('git -C "$root" archive --format=tar "$resolved_commit"');
    expect(materializer).toContain('destination must be below allowed root');
    expect(materializer).toContain('destination already exists');
    expect(materializer).not.toContain('git worktree');
    expect(materializer).not.toContain('git checkout');
  });

  it('records full, cache-hit and failed timings without caching failures', () => {
    expect(verifier).toContain('append_timing cache-hit');
    expect(verifier).toContain('append_timing failed');
    expect(verifier).toContain('append_timing full');
    expect(verifier).toContain('rm -f "$attestation"');
    expect(verifier).toContain('timings.jsonl');
  });

  it('installs a thin hook that verifies every pushed non-delete ref', () => {
    expect(installer).toContain('while read -r local_ref local_sha remote_ref remote_sha');
    expect(installer).toContain('scripts/git/pre-push-verified-state');
    expect(installer).toContain('chmod +x "$hook"');
  });
});
