import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const appUpgrade = fs.readFileSync(path.join(root, 'scripts/nix-app/upgrade-operator-app'), 'utf8');
const start = fs.readFileSync(path.join(root, 'start.sh'), 'utf8');
const prebuiltNixBuilder = fs.readFileSync(path.join(root, 'scripts/nix-app/build-tower-app-from-verified-dist'), 'utf8');
const prebuiltNixGuards = fs.readFileSync(path.join(root, 'scripts/nix-app/rehearse-prebuilt-nix-artifact-guards'), 'utf8');

describe('Operator app-only upgrade source contract', () => {
  it('reuses a digest-bound app-only attestation and otherwise builds the exact commit', () => {
    expect(appUpgrade).toContain('git -C "$repo_root" archive "$source_rev"');
    expect(appUpgrade).toContain("x.get('profile')=='app-only'");
    expect(appUpgrade).toContain("x.get('sha')==sha");
    expect(appUpgrade).toContain('verified app artifact digest mismatch');
    expect(appUpgrade).toContain("artifact_source='prepush-attestation'");
    expect(appUpgrade).toContain('(cd "$source_dir" && TOWER_SOURCE_SHA="$source_rev" npm run build)');
    expect(appUpgrade).not.toContain('(cd "$source_dir" && npm run build)');
    expect(appUpgrade).toContain('node "$source_dir/scripts/verify-frontend-release.mjs" "$artifact_path/dist/frontend" "$source_rev"');
    expect(appUpgrade.indexOf('node "$source_dir/scripts/verify-frontend-release.mjs"')).toBeLessThan(appUpgrade.indexOf('cp -a "$artifact_path/dist/frontend"'));
    expect(appUpgrade).toContain('dist/runtime-packages/@tower/shared');
    expect(appUpgrade).not.toContain('nix build');
    expect(appUpgrade).not.toContain('push-main-safe');
    expect(appUpgrade).not.toContain('pre-push-verified-state verify-and-run');
    expect(appUpgrade).not.toContain('tower-worker-maintenance');
    expect(appUpgrade).not.toContain('fleet-nix');
  });

  it('builds fallback artifacts with the immutable exact-SHA dependency cache', () => {
    expect(appUpgrade).toContain('TOWER_PREPUSH_DEPENDENCY_CACHE');
    expect(appUpgrade).toContain('"$dependency_cache" "$repo_root" "$source_rev" "$source_dir"');
    expect(appUpgrade).not.toContain('ln -s "$repo_root/node_modules"');
    expect(appUpgrade).not.toContain('ln -s "$repo_root/packages/backend/node_modules"');
  });

  it('assembles verified dist through a pure wrapper flake and checks exact revision', () => {
    expect(prebuiltNixBuilder).toContain("x.get('profile')=='app-only'");
    expect(prebuiltNixBuilder).toContain('artifact digest mismatch');
    expect(prebuiltNixBuilder).toContain('store add-path --name');
    expect(prebuiltNixBuilder).toContain('inputs.artifact.flake = false');
    expect(prebuiltNixBuilder).toContain('mkTowerAppFromDist artifact');
    expect(prebuiltNixBuilder).not.toContain('--impure');
    expect(prebuiltNixBuilder).toContain('assembled closure revision mismatch');
    expect(prebuiltNixGuards).toContain('prebuilt_nix_artifact_guards=ok');
  });

  it('fails closed for baseline, dependency, migration, launcher, Worker, and Fleet changes', () => {
    for (const value of [
      '"flake.nix"', '"flake.lock"', '"package.json"', '"package-lock.json"',
      '"packages/backend/db/migrations/"', '"packages/backend/sandbox-images/"',
      '"scripts/nix-app/tower-app-"', '"scripts/nix-app/cutover-"',
      '"scripts/nix-app/install-"', '"scripts/nix-app/worker-"', '"scripts/fleet/"',
    ]) expect(appUpgrade).toContain(value);
    expect(appUpgrade).toContain("'nix-required'");
  });

  it('classifies SDK patch drift against the runtime baseline, even at the live app revision', () => {
    expect(appUpgrade).toContain('classification="$(classify "$baseline_rev" "$source_rev")"');
    expect(appUpgrade).toContain('$baseline/share/tower/release-manifest.json');
    // Execute the embedded classifier, rather than only checking its path list.
    const start = appUpgrade.indexOf('import json,sys\np=[x.strip()');
    const end = appUpgrade.indexOf("\n}", start);
    const code = appUpgrade.slice(start, end).replace(/'$/, '');
    const result = JSON.parse(execFileSync('python3', ['-c', code], {
      input: 'scripts/apply-pi-eventstream-patch.mjs\npackages/backend/engines/pi-engine.ts\n', encoding: 'utf8',
    }));
    expect(result.eligible).toBe(false);
    expect(result.blockedPaths).toEqual(['scripts/apply-pi-eventstream-patch.mjs']);
    expect(appUpgrade).toContain("'status':'nix-required' if not c['eligible']");
  });

  it('pins the live Nix baseline and refuses apply after a baseline change', () => {
    expect(appUpgrade).toContain('["baselineStore"]');
    expect(appUpgrade).toContain('live baseline changed after prepare');
    expect(appUpgrade).toContain('NIX_RENDERER_BIN="$baseline/bin/tower-nix-render"');
    expect(appUpgrade).toContain('"$baseline/bin/tower-app-pdf-smoke"');
  });

  it('uses detached apply, exact approval, verification, and automatic rollback', () => {
    expect(appUpgrade).toContain('[[ "$approve_rev" = "$source_rev" ]]');
    expect(appUpgrade).toContain('TOWER_OPERATOR_APP_LOCK_STALE_SEC');
    expect(appUpgrade).toContain('acquire_lock_dir "$lock_dir"');
    expect(appUpgrade).toContain('if [[ -d "$lock_dir" ]]');
    expect(appUpgrade).toContain('rm -f "$lock_dir/owner"');
    expect(appUpgrade).toContain('setsid nohup "$0" __runner');
    expect(appUpgrade).toContain('export NODE_ENV=production TOWER_DEPLOYMENT_ID=production');
    expect(appUpgrade).toContain('scripts/deploy-verify.mjs');
    expect(appUpgrade).toContain("x.get('sourceRev')==sys.argv[2]");
    expect(appUpgrade).toContain('rollback-started');
    expect(appUpgrade).toContain('rollback-verified');
    expect(appUpgrade).toContain('unset TOWER_VERSION TOWER_BASE_VERSION GIT_SHA SOURCE_REV TOWER_GIT_SHA TOWER_SOURCE_REV');
    expect(appUpgrade).toContain('unset BUILD_TIME FLAKE_LOCK_NAR_HASH TOWER_BUILD_TIME TOWER_COMMITS_SINCE_TAG');
    expect(appUpgrade).toContain('Operator app artifact verified; Worker and Fleet unchanged');
  });

  it('exposes explicit plan, prepare, apply, and status entry points', () => {
    for (const command of ['prod-app-plan', 'prod-app-prepare', 'prod-app-apply', 'prod-app-status']) {
      expect(start).toContain(`${command})`);
    }
  });
});
