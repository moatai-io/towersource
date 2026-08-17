import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const upgrade = fs.readFileSync(path.join(process.cwd(), 'scripts/nix-app/upgrade-production'), 'utf8');
const prewarm = fs.readFileSync(path.join(process.cwd(), 'scripts/nix-app/prewarm-production'), 'utf8');
const prewarmCoordinator = fs.readFileSync(path.join(process.cwd(), 'scripts/nix-app/prewarm-coordinator'), 'utf8');
const runtimeBoxSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts/nix-app/tower-app-runtime-box-smoke'), 'utf8');
const fleetSecurityAudit = fs.readFileSync(path.join(process.cwd(), 'scripts/fleet/fleet-security-audit'), 'utf8');
const start = fs.readFileSync(path.join(process.cwd(), 'start.sh'), 'utf8');
const flake = fs.readFileSync(path.join(process.cwd(), 'flake.nix'), 'utf8');

describe('Nix production prepare and service transition source contract', () => {
  it('packages compiled @tower/shared runtime files in the immutable closure', () => {
    expect(flake).toContain('cp -R dist/backend/packages/shared/. "$app/packages/shared/"');
    expect(flake).toContain('ln -s ../../packages/shared "$app/node_modules/@tower/shared"');
    expect(flake).toContain('test -f "$out/lib/tower/packages/shared/index.js"');
    expect(flake).toContain("node -e \"import('$out/lib/tower/dist/backend/packages/backend/routes/api.js')\"");
  });

  it('keeps npm dependency identity stable across ordinary app commits', () => {
    expect(flake).toContain('towerAppNpmDepsSrc = pkgs.runCommand "tower-app-npm-inputs"');
    expect(flake).toContain('towerAppRuntime = pkgs.stdenvNoCC.mkDerivation');
    expect(flake).toContain('for runtimeDependency in ${towerAppRuntime}/node_modules/*');
    expect(flake).toContain('ln -s ${towerAppRuntime}/packages/backend/node_modules "$app/packages/backend/node_modules"');
    expect(flake).toContain('npmDepsVersion = "lock-${builtins.substring 0 16 (builtins.hashFile "sha256" ./package-lock.json)}"');
    expect(flake).toContain('version = npmDepsVersion');
    expect(flake).toContain('src = towerAppNpmDepsSrc');
    const depsBlock = flake.slice(flake.indexOf('towerAppNpmDeps ='), flake.indexOf('towerApp = pkgs.stdenvNoCC.mkDerivation'));
    expect(depsBlock).not.toContain('releaseVersion');
    expect(depsBlock).not.toContain('towerAppSrc');
  });

  it('separates Operator-local fast activation from full Fleet promotion preparation', () => {
    expect(upgrade).toContain('upgrade-production prepare-local [--source-rev FULL_40_CHAR_REV]');
    expect(upgrade).toContain('upgrade-production activate-local --approve-rev FULL_40_CHAR_REV');
    expect(upgrade).toContain('Operator-local closure prepared; unsigned and not Fleet deployable');
    expect(upgrade).toContain('reused exact Operator-local closure and prior probe evidence');
    expect(upgrade).toContain("x.get('phase')=='local-prepared'");
    expect(upgrade).toContain('manifest_rev==rev');
    expect(upgrade).toContain('"promotionLevel":"operator-local"');
    expect(upgrade).toContain('"reused":true');
    expect(upgrade).toContain('Fast Prod refuses DB migration changes');
    expect(upgrade).not.toContain('Fast Prod refuses Runtime Box input changes');
    expect(upgrade).toContain('Runtime Box inputs are a separate release plane');
    expect(upgrade).toContain('activation requires $required_phase state');
    const localBlock = upgrade.slice(upgrade.indexOf('prepare_local_release()'), upgrade.indexOf('prepare_release()'));
    expect(localBlock).toContain('"$probe_cmd" "$store"');
    expect(localBlock).not.toContain('run_privileged "$publish_cmd"');
    expect(localBlock).not.toContain('run_privileged "$mirror_cmd"');
    expect(localBlock).not.toContain('"$runtime_image_cmd" ensure');
  });

  it('separates read-only plan, non-mutating Fleet prepare and approved activation', () => {
    expect(upgrade).toContain('upgrade-production plan [--source-rev FULL_40_CHAR_REV]');
    expect(upgrade).toContain('upgrade-production prepare');
    expect(upgrade).toContain('upgrade-production activate --approve-rev FULL_40_CHAR_REV');
    expect(upgrade).toContain('signed closure prepared; production unchanged');
    expect(upgrade).toContain("x['build']");
    expect(upgrade).toContain("x['publish']");
    expect(upgrade).toContain("x['runtimeArtifact']");
    expect(upgrade).toContain("x['mirror']");
    expect(upgrade).toContain("x['health']");
    expect(upgrade).toContain('"timingsMs":%s');
    expect(upgrade).toContain('--promotion-sign-copy-proven');
    expect(upgrade).toContain('without repeating the');
    expect(upgrade).toContain('same 451-path NAR verification');
    expect(upgrade).toContain('approved revision is not the prepared revision');
    expect(upgrade).not.toContain('git push');
    expect(upgrade).not.toContain('git commit');
    expect(upgrade).not.toContain('git fetch');
  });

  it('uses GC current as the signed comparison baseline while recovering from Host authority', () => {
    expect(upgrade).toContain("elif authority=='host':");
    expect(upgrade).toContain("Host recovery requires a valid GC current Nix baseline");
    expect(upgrade).toContain("print('host-recovery')");
    expect(upgrade).toContain("'runningAuthority':authority");
  });

  it('pins deployment authority to an attested remote ancestor instead of mutable local HEAD', () => {
    expect(upgrade).toContain('merge-base --is-ancestor "$target" "$origin"');
    expect(upgrade).toContain('target revision is not contained in origin/main');
    expect(upgrade).toContain('"$attestation_cmd" verify-attestation "$target"');
    expect(upgrade).toContain("'targetRemoteRelation':relation");
    expect(upgrade).not.toContain('HEAD must equal origin/main');
    expect(upgrade).not.toContain('prepared revision is no longer origin/main');
  });

  it('builds, probes, publishes and mirrors before any service transition', () => {
    expect(upgrade).toContain('git+file://$repo_root?rev=$target_rev#towerApp');
    expect(upgrade).toContain('closure sourceRev does not equal requested revision');
    expect(upgrade).toContain('run_privileged "$publish_cmd"');
    expect(upgrade).toContain('run_privileged "$mirror_cmd"');
    expect(upgrade).toContain('run_privileged "$health_cmd"');
    expect(upgrade.indexOf('run_privileged "$health_cmd"')).toBeLessThan(upgrade.indexOf('activate_release()'));
  });

  it('reuses an already prepared exact artifact without rebuilding', () => {
    expect(upgrade).toContain("x.get('phase')=='prepared'");
    expect(upgrade).toContain('read_reusable_fleet_promotion');
    expect(upgrade).toContain("row.get('runtimeBoxArtifactFingerprint')");
    expect(upgrade).toContain('reuseSource');
    expect(upgrade).toContain('"reused":true');
    expect(upgrade).toContain('approved revision is not the prepared revision');
  });

  it('runs independent public security probes in one timeout window', () => {
    expect(fleetSecurityAudit).toContain('concurrent.futures.ThreadPoolExecutor');
    expect(fleetSecurityAudit).toContain('max_workers=len(probe_ports)');
    expect(fleetSecurityAudit).toContain('probes=dict(pool.map(probe,probe_ports))');
  });

  it('keeps DB migrations separate from both prepare and activation', () => {
    expect(upgrade).toContain('packages/backend/db/migrations');
    expect(upgrade).toContain('--ack-db-migrations-separate');
    expect(upgrade).toContain('DB migration files changed; review separately');
    expect(upgrade).not.toContain('db:migrate');
    expect(upgrade).not.toContain('run-migrations');
  });

  it('hands only service transition and post-transition verification to a detached runner', () => {
    expect(upgrade).toContain('setsid nohup env TOWER_PROD_UPGRADE_LOG_FILE="$log_file" "$0" __detached_runner');
    expect(upgrade).toContain('transition-started');
    expect(upgrade).toContain('promoting-generation');
    expect(upgrade).toContain('"$generation_manager" promote');
    expect(upgrade).toContain('service transition ended in phase');
    expect(upgrade).toContain('transition-reconciled');
    expect(upgrade).toContain('exact live Nix authority verified');
    expect(upgrade).toContain("status.get('authority')=='nix'");
    expect(upgrade).toContain("health.get('metadataSource')=='injected'");
    expect(upgrade).toContain('reconcile_stale_transition_state');
    expect(upgrade).toContain('restart-safe reconciliation verified exact live authority, GC generation and external health');
    expect(upgrade).toContain('record_operator_verification "$source_rev" "$store" "$promotion_level"');
    expect(upgrade).toContain('production_root="${TOWER_PRODUCTION_ROOT:-$repo_root}"');
    expect(upgrade).toContain('TOWER_PRODUCTION_ROOT="$production_root"');
  });

  it('runs Runtime Box smoke with an isolated Docker client config', () => {
    expect(runtimeBoxSmoke).toContain('docker_config_dir="$(mktemp -d /tmp/tower-runtime-box-docker-config.XXXXXX)"');
    expect(runtimeBoxSmoke).toContain('env HOME=/tmp DOCKER_CONFIG="$docker_config_dir"');
    expect(runtimeBoxSmoke).toContain('docker run --rm --pull never');
    expect(runtimeBoxSmoke).toContain('--mount type=tmpfs,destination=/workspace');
  });

  it('verifies internal, external, Runtime Box functionality and pinned authority after activation', () => {
    expect(upgrade).toContain('tower-app-deploy-verify');
    expect(upgrade).not.toContain('node "$verify_cmd" --target tower-prod');
    expect(upgrade).toContain('TOWER_PROD_UPGRADE_EXTERNAL_HEALTH_URL');
    expect(upgrade).toContain('pm2 pid tower-prod');
    expect(upgrade).toContain('live Tower process lacks exact RUNTIME_BOX_IMAGE');
    expect(upgrade).toContain('RUNTIME_BOX_IMAGE="$runtime_box_image" TOWER_RUNTIME_BOX_SMOKE_PROCESS_PID="$tower_pid"');
    expect(upgrade).toContain("fail_upgrade 'Runtime Box functional smoke failed'");
    expect(upgrade).toContain("x.get('dockerApi')=='ok'");
    expect(upgrade).toContain("x.get('containerStart')=='ok'");
    expect(upgrade).toContain("x.get('sourceRev')==expected");
    expect(upgrade).toContain("x.get('gcCurrentMatchesProduction') is True");
    expect(upgrade).toContain('signed Nix production upgrade verified');
  });

  it('reports Runtime Box input changes without blocking Operator-local prepare', () => {
    expect(upgrade).toContain('runtimeChangedPaths');
    expect(upgrade).toContain('runtimeChangeRequired');
    const localBlock = upgrade.slice(upgrade.indexOf('prepare_local_release()'), upgrade.indexOf('read_reusable_fleet_promotion()'));
    expect(localBlock).not.toContain('sandbox-images/runtime-box-node22-python313');
    expect(localBlock).not.toContain('sandbox-images/runtime-box-operator-tools');
  });

  it('classifies host-only and test changes as no-runtime-change before Nix build', () => {
    expect(upgrade).toContain('classify_runtime_changes()');
    expect(upgrade).toContain('non_runtime_exact={"AGENTS.md","start.sh"}');
    expect(upgrade).toContain('non_runtime_scripts={"scripts/nix-app/upgrade-production"');
    expect(upgrade).toContain('runtimeChangeRequired');
    expect(upgrade).toContain("status='up-to-date' if rev==running and authority=='nix' else ('no-runtime-change'");
    expect(upgrade).toContain('no Nix build or Prod cutover required');
    const localBlock = upgrade.slice(upgrade.indexOf('prepare_local_release()'), upgrade.indexOf('read_reusable_fleet_promotion()'));
    const fullBlock = upgrade.slice(upgrade.indexOf('prepare_release()'), upgrade.indexOf('activate_release()'));
    expect(localBlock).toContain('[[ "$runtime_required" = true ]] ||');
    expect(fullBlock).not.toContain('[[ "$runtime_required" = true ]] ||');
    expect(upgrade).toContain('Full prepare may promote the exact closure already verified on Operator Prod');
  });

  it('guides mismatched activation modes and provides terminal waiting with per-run logs', () => {
    expect(upgrade).toContain('next: ./start.sh prod-upgrade --approve-rev $prepared_rev');
    expect(upgrade).toContain('next: ./start.sh prod-upgrade-fast --approve-rev $prepared_rev');
    expect(upgrade).toContain('upgrade-production wait [--timeout SEC]');
    expect(upgrade).toContain('run_id="$(date +%Y%m%dT%H%M%S)-${approved_rev:0:12}"');
    expect(upgrade).toContain('if [[ "$invocation_action" = __detached_runner || "$test_mode" = 1 ]]');
    expect(upgrade).toContain("'logFile':log_file");
    expect(upgrade).toContain('TOWER_PROD_UPGRADE_LOG_FILE="$log_file"');
    expect(start).toContain('prod-upgrade-wait)');
    expect(start).toContain('upgrade-production wait "$@"');
  });

  it('prepares or reuses an immutable Runtime Box artifact before mirroring', () => {
    expect(upgrade).toContain('promote-runtime-box-image');
    expect(upgrade).toContain('ensure --source-rev "$target_rev"');
    expect(upgrade).toContain('preparing or reusing immutable Runtime Box artifact');
  });

  it('records successful Operator-local and Fleet-promoted verification levels', () => {
    expect(upgrade).toContain('record_operator_verification "$target_rev" "$store" operator-local');
    expect(upgrade).toContain('record_operator_verification "$target_rev" "$store" fleet-promoted');
    expect(upgrade).toContain('Operator-local Nix production upgrade verified; not Fleet promoted');
    expect(upgrade).toContain('verification-status --source-rev FULL_40_CHAR_REV');
    expect(upgrade).toContain('revision lacks successful Operator verification');
  });

  it('pins one pushed revision for detached prewarm without following later tips', () => {
    expect(start).toContain('prod-prewarm)');
    expect(start).toContain('prewarm-production start "$@"');
    expect(start).toContain('prod-prewarm-auto)');
    expect(start).toContain('prewarm-coordinator enqueue "$@"');
    expect(start).toContain('prod-prewarm-auto-status)');
    expect(start).toContain('prewarm-coordinator status');
    expect(start).toContain('prod-prewarm-status)');
    expect(start).toContain('prod-prewarm-wait)');
    expect(start).toContain('prod-prewarm-apply)');
    expect(start).toContain('prewarm-production apply "$@"');
    expect(start).toContain('upgrade-production plan "$@"');
    expect(prewarm).toContain('git -C "$repo_root" merge-base --is-ancestor "$source_rev" "$origin"');
    expect(prewarm).toContain('setsid nohup env TOWER_PROD_PREWARM_STATE="$state"');
    expect(prewarm).toContain('pre-push-verified-state" "$source_rev"');
    expect(prewarm).toContain('prepare-local --source-rev "$source_rev"');
    expect(prewarm).toContain('activate-local --approve-rev "$source_rev"');
    expect(prewarm).toContain("x.get('phase')=='done'");
    expect(prewarm).toContain("p.get('phase')=='local-prepared'");
    expect(prewarm).toContain('"$run_root/$source_rev"');
    expect(prewarm).not.toContain('source_rev="$(git');
    expect(prewarmCoordinator).toContain('Operator and Fleet readiness prepared; no customer cutover performed');
  });

  it('exposes fast and full promotion commands from start.sh', () => {
    expect(start).toContain('prod-upgrade-fast-prepare)');
    expect(start).toContain('upgrade-production prepare-local "$@"');
    expect(start).toContain('prod-upgrade-fast)');
    expect(start).toContain('upgrade-production activate-local "$@"');
    expect(start).toContain('prod-upgrade-plan)');
    expect(start).toContain('prod-upgrade-prepare)');
    expect(start).toContain('upgrade-production prepare "$@"');
    expect(start).toContain('upgrade-production activate "$@"');
    expect(start).toContain('prod-upgrade-status)');
    expect(start).toContain('prod-upgrade-wait)');
    expect(start).toContain('--ack-db-migrations-separate');
    expect(start).not.toContain('prod-restart)');
    expect(start).not.toContain('prod-start | prod-stop | prod-restart');
  });
});
