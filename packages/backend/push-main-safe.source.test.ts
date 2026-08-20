import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'scripts/git/push-main-safe'), 'utf8');
const coordinator = fs.readFileSync(path.join(process.cwd(), 'scripts/nix-app/prewarm-coordinator'), 'utf8');
const commitPreflight = fs.readFileSync(path.join(process.cwd(), 'scripts/git/commit-preflight-coordinator'), 'utf8');
const commitHookInstaller = fs.readFileSync(path.join(process.cwd(), 'scripts/git/install-commit-preflight-hook'), 'utf8');

describe('push-main-safe source contract', () => {
  it('classifies main synchronization without AI interpretation', () => {
    expect(source).toContain('push-main-safe plan|prepare|apply [--source-rev FULL_SHA|--approve-rev FULL_SHA]');
    expect(source).toContain('pre-push-verified-state" "$target_sha"');
    expect(source).toContain('"status":"prepared"');
    expect(source).toContain('flock -n 9');
    expect(source).toContain('rev-list --left-right --count');
    expect(source).toContain('state=up-to-date');
    expect(source).toContain('state=ready-to-push');
    expect(source).toContain('state=behind');
    expect(source).toContain('state=diverged');
    expect(source).toContain('workingTreeDirtyIgnored');
  });

  it('serializes exact attestation writers so concurrent background and upgrade checks reuse one result', () => {
    const verifier = fs.readFileSync(path.join(process.cwd(), 'scripts/git/pre-push-verified-state'), 'utf8');
    expect(verifier).toContain('lock_file="$cache_root/$cache_key.lock"');
    expect(verifier).toContain('exec 8>"$lock_file"');
    expect(verifier).toContain('flock 8');
  });

  it('keeps automatic prewarm opt-in and coordinates an explicitly enabled run', () => {
    expect(source).toContain('TOWER_PUSH_AUTO_PREWARM:-0');
    expect(source).toContain('prewarm-coordinator" enqueue --source-rev "$target_sha"');
    expect(source).toContain('autoPrewarm');
    expect(coordinator).toContain('TOWER_PREWARM_DEBOUNCE_SEC:-45');
    expect(coordinator).toContain('mkdir "$lock"');
    expect(coordinator).toContain('latest="$(read_candidate)"');
    expect(coordinator).toContain('nice -n 10 ionice -c 2 -n 7');
    expect(coordinator).toContain('prewarm-production" wait');
    expect(coordinator).toContain('fleet-deploy-fast" prepare');
    expect(coordinator).not.toContain('fleet-deploy-run');
    expect(coordinator).not.toContain('activate-local');
    expect(coordinator).toContain('no automatic retry');
  });

  it('preflights only the latest exact local commit in a low-priority background single flight', () => {
    expect(commitPreflight).toContain('TOWER_COMMIT_PREFLIGHT_DEBOUNCE_SEC:-45');
    expect(commitPreflight).toContain('mkdir "$lock"');
    expect(commitPreflight).toContain('latest="$(read_candidate)"');
    expect(commitPreflight).toContain('nice -n 10 ionice -c 2 -n 7');
    expect(commitPreflight).toContain('"$verifier" "$observed"');
    expect(commitPreflight).toContain('no automatic retry');
    expect(commitPreflight).toContain('will not retry; continuing with newer candidate');
    expect(commitPreflight).toContain('set +e; "$verifier" "$observed"; rc=$?; set -e');
    expect(commitPreflight).toContain('"$verifier" verify-attestation "$status_rev"');
    expect(commitPreflight).toContain('verified after an earlier background failure; no external mutation');
    expect(commitPreflight).not.toContain('git push');
    expect(commitPreflight).toContain('TOWER_HEAVY_WORK_LOCK_FILE');
    expect(commitPreflight).toContain('flock -w "$heavy_wait" 8');
    expect(commitPreflight).not.toContain('prewarm-production');
    expect(commitPreflight).not.toContain('fleet-deploy');
    expect(commitPreflight).not.toContain('upgrade-production');
    expect(commitPreflight).not.toContain('pg_dump');
    expect(commitHookInstaller).toContain('.git/hooks/post-commit');
    expect(commitHookInstaller).toContain('enqueue --source-rev "$rev"');
    expect(commitHookInstaller).toContain('|| true');
  });

  it('pushes the approved ancestor commit without following later local commits', () => {
    expect(source).toContain('target_sha="$approved_rev"');
    expect(source).toContain('merge-base --is-ancestor "$approved_rev" HEAD');
    expect(source).toContain('push "$remote" "$target_sha:$branch"');
    expect(source).not.toContain('--force');
    expect(source).not.toContain('reset --hard');
    expect(source).not.toContain('stash');
    expect(source).toContain('hook-or-remote-race');
    expect(source).toContain('[[ "$actual" = "$target_sha" ]]');
    expect(source).toContain('approved-revision-not-on-current-main');
    expect(source).toContain('laterLocalCommitsIgnored');
  });
});
