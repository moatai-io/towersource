import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const verifier = read('scripts/git/pre-push-verified-state');
const materializer = read('scripts/git/materialize-committed-source');
const installer = read('scripts/git/install-pre-push-hook');
const lockWaitRehearsal = read('scripts/git/rehearse-pre-push-lock-wait');
const classifier = read('scripts/git/classify-prepush-profile');
const dependencyCache = read('scripts/git/materialize-prepush-dependencies');
const profileRehearsal = read('scripts/git/rehearse-prepush-profile-classification');
const dependencyRehearsal = read('scripts/git/rehearse-prepush-dependency-cache');
const artifactRehearsal = read('scripts/git/rehearse-prepush-app-artifact');
const compatibleAttestationRehearsal = read('scripts/git/rehearse-prepush-compatible-attestation');
const staleSnapshotRehearsal = read('scripts/git/rehearse-prepush-stale-snapshot-guard');

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
    expect(verifier).toContain('for tool in "$0" "$classifier" "$materializer" "$dependency_cache"');
    expect(verifier).toContain("sha256sum \"$tool\"");
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
    expect(verifier).toContain("x.get('profile')=='full'");
    expect(verifier).toContain("x.get('command')=='npm run preflight'");
    expect(verifier).toContain("x.get('validationContext')==context");
    expect(verifier).toContain("'status':'passed'");
    expect(verifier).toContain('"sha":"%s"');
    expect(compatibleAttestationRehearsal).toContain('prepush_compatible_attestation=ok');
  });

  it('persists failed output outside .git and rejects stale exact-SHA retries', () => {
    expect(verifier).toContain('failure_marker="$cache_root/$cache_key.failed.json"');
    expect(verifier).toContain('${XDG_STATE_HOME:-$HOME/.local/state}/tower/prepush-failures/$repo_state_key');
    expect(verifier).toContain('TOWER_PREPUSH_FAILURE_LOG_DIR');
    expect(verifier).toContain('chmod 700 "$failure_log_root"');
    expect(verifier).toContain('chmod 600 "$failure_log"');
    expect(verifier).not.toContain('umask 077');
    expect(verifier).toContain("'failedCommand':command");
    expect(verifier).toContain("'logPath':log_path");
    expect(verifier).toContain("'tailSummary':tail");
    expect(verifier).toContain('Durable failure log: $failure_log');
    expect(verifier).toContain('working_tree_fingerprint');
    expect(verifier).toContain('commit the fix to create a new exact SHA before rerunning preflight');
    expect(verifier).toContain("'workingTreeFingerprint':working_tree");
    expect(staleSnapshotRehearsal).toContain('prepush_stale_snapshot_guard=ok');
  });

  it('runs the full preflight from an exact archive snapshot with owned dependencies', () => {
    expect(verifier).toContain('TOWER_PREPUSH_SNAPSHOT_ROOT');
    expect(verifier).toContain('${TMPDIR:-/tmp}/tower-prepush-snapshots');
    expect(verifier).not.toContain('snapshot_root="${TOWER_PREPUSH_SNAPSHOT_ROOT:-$cache_root/runs}"');
    expect(verifier).toContain('snapshotRoot=%s');
    expect(verifier).toContain('TOWER_PREPUSH_SNAPSHOT_TTL_HOURS');
    expect(verifier).toContain("os.kill(pid,0)");
    expect(verifier).toContain('shutil.rmtree(path,ignore_errors=True)');
    expect(verifier).toContain('scripts/git/materialize-committed-source');
    expect(verifier).toContain('explicit_preflight_cmd="${TOWER_PREPUSH_COMMAND:-}"');
    expect(verifier).toContain('classifier="${TOWER_PREPUSH_CLASSIFIER');
    expect(verifier).toContain('dependency_cache="${TOWER_PREPUSH_DEPENDENCY_CACHE');
    expect(verifier).toContain('TOWER_PREPUSH_VITEST_MAX_WORKERS:-4');
    expect(verifier).toContain('VITEST_MAX_WORKERS="$vitest_max_workers"');
    expect(verifier).toContain('dependency cache helper unavailable');
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

  it('records lock wait plus full, cache-hit and failed timings without caching failures', () => {
    expect(verifier).toContain('start_ms="$(now_ms)"');
    expect(verifier).toContain('lock_wait_ms=$(( $(now_ms) - lock_start_ms ))');
    expect(verifier).toContain("'lockWaitMs':int(lock_wait)");
    expect(verifier).toContain('append_timing cache-hit "$total_ms" "$lock_wait_ms" 0 0');
    expect(verifier).toContain('append_timing failed "$total_ms" "$lock_wait_ms" "$snapshot_ms" "$preflight_ms"');
    expect(verifier).toContain('append_timing full "$total_ms" "$lock_wait_ms" "$snapshot_ms" "$preflight_ms"');
    expect(verifier).toContain('lock-wait=${lock_wait_ms}ms');
    expect(verifier).toContain('rm -f "$attestation"');
    expect(verifier).toContain('timings.jsonl');
    expect(lockWaitRehearsal).toContain("assert hit['lockWaitMs'] >= 500");
    expect(lockWaitRehearsal).toContain("assert hit['durationMs'] >= hit['lockWaitMs']");
  });

  it('classifies exact-SHA changes fail-closed and reuses immutable lockfile dependency trees', () => {
    expect(classifier).toContain("profile = 'deploy-contract'");
    expect(classifier).toContain("profile = 'app-only'");
    expect(classifier).toContain("profile = 'full'");
    expect(classifier).toContain("reasons.append('unclassified-path')");
    expect(classifier).not.toContain('npm run build');
    expect(dependencyCache).toContain('package-lock.json');
    expect(dependencyCache).toContain('${XDG_CACHE_HOME:-$HOME/.cache}/tower/prepush-deps');
    expect(dependencyCache).not.toContain('$root/.git/tower-prepush-deps');
    expect(dependencyCache).toContain('scripts/apply-pi-eventstream-patch.mjs');
    expect(dependencyCache.match(/scripts\/pi-sdk-behavior\.mjs/g)).toHaveLength(2);
    expect(dependencyCache).toContain('(cd "$build" && npm ci)');
    expect(dependencyCache).toContain('cache entry is immutable after its ready marker');
    expect(dependencyCache).toContain('ln -s "$src" "$dst"');
    expect(dependencyCache).not.toContain('$root/node_modules');
    expect(profileRehearsal).toContain('prepush_profile_classification=ok');
    expect(dependencyRehearsal).toContain('prepush_dependency_cache=ok');
  });

  it('publishes app-only build output as an immutable digest-bound artifact', () => {
    expect(verifier).toContain('TOWER_PREPUSH_ARTIFACT_DIR');
    expect(verifier).toContain('[[ "$profile" = app-only && "$preflight_cmd" == *"npm run build"* ]]');
    expect(verifier).toContain("data['appArtifact']={'path':artifact_path,'distDigest':'sha256:'+artifact_digest}");
    expect(verifier).toContain("'schemaVersion':4");
    expect(verifier).toContain("'validationContext':validation_context");
    expect(verifier).toContain("-C \"$artifact_build\" dist | sha256sum");
    expect(artifactRehearsal).toContain('prepush_app_artifact=ok');
  });

  it('installs a thin hook that verifies every pushed non-delete ref', () => {
    expect(installer).toContain('while read -r local_ref local_sha remote_ref remote_sha');
    expect(installer).toContain('scripts/git/pre-push-verified-state');
    expect(installer).toContain('chmod +x "$hook"');
  });
});

it('materializes dependencies for direct deployment runner commands', () => {
  const verifier = read('scripts/git/pre-push-verified-state');
  expect(verifier).toContain('$preflight_cmd" == *"node scripts/run-deploy-contract-tests.mjs"*');
});

it('requires build artifacts only when app validation actually builds', () => {
  expect(verifier).toContain('if [[ "$profile" = app-only && "$preflight_cmd" == *"npm run build"* ]]; then');
});
