import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PACKAGED_RELEASE_OPTIONAL_ENV,
  PACKAGED_RELEASE_REQUIRED_ENV,
} from './services/app-runtime-contract.js';

const launcher = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/tower-app-start-production'),
  'utf8',
);
const cutover = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/cutover-production'),
  'utf8',
);
const cutoverRehearsal = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/rehearse-detached-cutover-orchestrator'),
  'utf8',
);
const pinnedRestart = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/restart-pinned-production'),
  'utf8',
);
const prodRestart = fs.readFileSync(
  path.join(process.cwd(), 'scripts/prod-restart-committed.sh'),
  'utf8',
);
const fullBackendCanary = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/run-disposable-full-backend-canary'),
  'utf8',
);
const flake = fs.readFileSync(path.join(process.cwd(), 'flake.nix'), 'utf8');
const pdfSmoke = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/tower-app-pdf-smoke'),
  'utf8',
);
const deployVerify = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/tower-app-deploy-verify'),
  'utf8',
);
const productionUpgrade = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/upgrade-production'),
  'utf8',
);
const staleLockRehearsal = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-app/rehearse-upgrade-stale-lock'),
  'utf8',
);

describe('Phase 6A Nix production launcher source contract', () => {
  it('serializes heavy release work and limits Nix parallelism on small VMs', () => {
    expect(productionUpgrade).toContain('TOWER_HEAVY_WORK_LOCK_FILE');
    expect(productionUpgrade).toContain('TOWER_PROD_UPGRADE_LOCK_STALE_SEC');
    expect(productionUpgrade).toContain('acquire_lock_dir "$lock_dir"');
    expect(productionUpgrade).toContain("os.kill(pid,0)");
    expect(productionUpgrade).toContain("bootId=%s");
    expect(productionUpgrade).toContain('if [[ -d "$lock_dir" ]]');
    expect(productionUpgrade).toContain('printf \'pid=%s\\nbootId=%s\\ncreatedAt=%s\\n\' "$runner_pid"');
    expect(staleLockRehearsal).toContain('upgrade_stale_lock=ok');
    expect(productionUpgrade).toContain('flock -w "$heavy_wait" 8');
    expect(productionUpgrade).toContain('TOWER_NIX_MAX_JOBS:-1');
    expect(productionUpgrade).toContain('TOWER_NIX_CORES:-2');
    expect(productionUpgrade).toContain('--option max-jobs "$nix_max_jobs" --option cores "$nix_cores"');
    expect(productionUpgrade).toContain('TOWER_PROD_UPGRADE_PREBUILT_APP_BUILDER');
    expect(productionUpgrade).toContain('build_tower_app "$target_rev"');
    expect(productionUpgrade).toContain('verified prebuilt app assembly failed closed');
    expect(productionUpgrade).toContain('NODE_ENV=production TOWER_DEPLOYMENT_ID=production "$store/bin/tower-app-pdf-smoke"');
  });

  it('imports backend routes in install check with complete packaged release identity', () => {
    expect(flake).toContain("TOWER_PACKAGED_RELEASE=true TOWER_VERSION='${releaseVersion}' TOWER_BASE_VERSION='${releaseBaseVersion}' GIT_SHA='${sourceShortRev}' SOURCE_REV='${sourceRev}'");
    expect(flake).toContain('node -e "import(\'$out/lib/tower/dist/backend/packages/backend/routes/api.js\')"');
  });

  it('requires an explicit production acknowledgement before backend startup', () => {
    expect(launcher).toContain('TOWER_RUN_MODE must equal nix-production');
    expect(launcher).toContain('TOWER_NIX_PRODUCTION_PROFILE must equal authority or canary');
    expect(launcher).toContain('TOWER_NIX_PRODUCTION_ACK must equal the closure SOURCE_REV');
    expect(launcher).toContain('action must be check or run');
  });

  it('keeps the existing PM2 production network and PostgreSQL authority contract', () => {
    expect(launcher).toContain("authority PORT must equal the existing Tower production port 32364");
    expect(launcher).toContain("DATABASE_URL must use PostgreSQL");
    expect(launcher).toContain("JWT_SECRET must be non-default");
    expect(launcher).toContain("authority PUBLIC_URL must use https");
  });

  it('allows only loopback marker-bound disposable full-backend canaries', () => {
    expect(launcher).toContain('canary HOST must be loopback');
    expect(launcher).toContain('canary PORT must not use a Tower authority port');
    expect(launcher).toContain('canary DATABASE_URL must use loopback PostgreSQL');
    expect(launcher).toContain('canary DATABASE_URL must contain TOWER_NIX_CANARY_MARKER');
  });

  it('requires writable runtime paths outside the immutable Nix store', () => {
    for (const envName of ['TOWER_RUNTIME_CWD', 'TOWER_DATA_DIR', 'WORKSPACE_ROOT', 'DEFAULT_CWD']) {
      expect(launcher).toContain(envName);
    }
    expect(launcher).toContain('must be outside /nix/store');
    expect(launcher).toContain('DEFAULT_CWD must be within WORKSPACE_ROOT');
  });

  it('requires a host rollback artifact before startup', () => {
    expect(launcher).toContain('TOWER_HOST_ROLLBACK_ENTRYPOINT');
    expect(launcher).toContain('rollback entrypoint must exist before Nix production startup');
    expect(launcher).toContain('rollback entrypoint must be a host artifact outside /nix/store');
  });

  it('derives fresh Primary Agent storage readiness from trusted live installation evidence', () => {
    expect(deployVerify).toContain('TOWER_PRIMARY_WORKER_ID');
    expect(deployVerify).toContain('tower-workbench-worker-{worker}.service');
    expect(deployVerify).toContain("re.findall(r'^User=");
    expect(deployVerify).toContain("os.environ.get('WORKSPACE_ROOT'");
    expect(deployVerify).toContain('NEW_PROJECT_STORAGE_WORKER_IDENTITY_REQUIRED');
    expect(deployVerify).toContain('NEW_PROJECT_STORAGE_INSTALLATION_UNTRUSTED');
    expect(deployVerify).not.toContain('new-project-storage-policy.json');
    expect(deployVerify.indexOf('NEW_PROJECT_STORAGE_WORKER_IDENTITY_REQUIRED')).toBeLessThan(deployVerify.indexOf('deploy-verify.mjs'));
  });

  it('hands production lifecycle ownership to a detached runner before stopping Host PM2', () => {
    expect(cutover).toContain('merge-base --is-ancestor "$source_rev" "$origin_rev"');
    expect(cutover).toContain('closure SOURCE_REV must remain in origin/main history');
    expect(cutover).not.toContain('closure SOURCE_REV must equal origin/main');
    expect(cutover).not.toContain('closure SOURCE_REV must equal repository HEAD');
    expect(cutover).toContain('tip may advance after this closure was signed and approved');
    expect(cutover).toContain('setsid nohup "$0" __detached_runner');
    expect(cutover).toContain('write_state detached');
    expect(cutover).toContain('production_root="${TOWER_PRODUCTION_ROOT:-$source_root}"');
    expect(cutover).toContain("TOWER_PRODUCTION_ROOT must be an absolute path");
    expect(cutover).toContain('production .env missing');
    expect(cutover).toContain('production rollback entrypoint missing');
    expect(cutover.match(/export NODE_ENV=production TOWER_DEPLOYMENT_ID=production/g)).toHaveLength(2);
    expect(cutover).toContain('export NODE_ENV=production TOWER_DEPLOYMENT_ID=production HOST="${HOST:-0.0.0.0}" PORT=32364');
    const foreground = cutover.slice(cutover.indexOf('store="${TOWER_APP_ROOT'));
    expect(foreground).not.toContain('pm2 stop "$target"');
  });

  it('keeps durable cutover state and independently verifies Host rollback', () => {
    for (const phase of [
      'prepared',
      'stopping-host',
      'starting-nix',
      'verifying',
      'finalizing',
      'done',
      'rollback-started',
      'rollback-verified',
      'rollback-failed',
    ]) {
      expect(cutover).toContain(phase);
    }
    expect(cutover).toContain('Nix cutover is already running');
    expect(cutover).toContain('pm2 stop "$target"');
    expect(cutover).toContain('pm2 delete "$target"');
    expect(cutover).toContain('tower-app-deploy-verify');
    expect(cutover).toContain('nix_verifier="$store/bin/tower-app-deploy-verify"');
    expect(cutover).toContain('host_verifier="$source_root/scripts/deploy-verify.mjs"');
    expect(cutover).toContain('restoring Host PM2 artifact');
    expect(cutover).toContain('"$post_hook" preflight');
    expect(cutover).toContain('"$post_hook" apply');
    expect(cutover).toContain('"$post_hook" rollback');
    expect(cutover).toContain('cp -a "$production_root/dist" "$backup/dist"');
    expect(cutover).toContain('source "$production_root/.env"');
    expect(cutover).toContain('pm2 start "$production_root/ecosystem.config.cjs" --only "$target" --update-env');
    expect(cutover).toContain('--project-root "$production_root"');
  });

  it('packages compiled @tower/shared for Host rollback restarts', () => {
    expect(prodRestart).toContain('dist-new/runtime-packages/@tower/shared');
    expect(prodRestart).toContain('cp packages/shared/package.json dist-new/runtime-packages/@tower/shared/package.json');
    expect(prodRestart).toContain('ln -s ../../dist/runtime-packages/@tower/shared node_modules/@tower/shared');
  });

  it('routes Nix-authoritative prod restart to the exact pinned closure without deploying latest', () => {
    expect(prodRestart).toContain('"$NIX_RESTART" detect');
    expect(prodRestart).toContain('exec "$NIX_RESTART" restart');
    expect(pinnedRestart).toContain('pm2_exec_path');
    expect(pinnedRestart).toContain('gcCurrentMatchesProduction');
    expect(pinnedRestart).toContain('GC current does not match production');
    expect(pinnedRestart).toContain('pm2 delete "$target"');
    expect(pinnedRestart).toContain('pm2 start "$launcher" --name "$target"');
    expect(pinnedRestart).toContain('export NODE_ENV=production TOWER_DEPLOYMENT_ID=production');
    expect(pinnedRestart).toContain('unset TOWER_VERSION TOWER_BASE_VERSION GIT_SHA SOURCE_REV TOWER_GIT_SHA TOWER_SOURCE_REV');
    expect(pinnedRestart).toContain('unset BUILD_TIME FLAKE_LOCK_NAR_HASH TOWER_BUILD_TIME TOWER_COMMITS_SINCE_TAG');
    expect(pinnedRestart).toContain('env -u PDF_EXPORT_RENDERER_MODE -u NIX_RENDERER_BIN "$expected_store/bin/tower-app-pdf-smoke"');
    expect(pinnedRestart).toContain('"timingsMs": json.loads(timings_json)');
    for (const phase of ['pm2Restart', 'deployVerify', 'pdfSmoke', 'healthIdentity', 'total']) {
      expect(pinnedRestart).toContain(`record_timing ${phase}`);
    }
    expect(pinnedRestart).toContain('verify_pid=$!');
    expect(pinnedRestart).toContain('pdf_pid=$!');
    expect(pinnedRestart).toContain('wait "$verify_pid"');
    expect(pinnedRestart).toContain('wait "$pdf_pid"');
    expect(pinnedRestart).toContain('setsid nohup "$0" __detached_runner');
    expect(pinnedRestart).toContain('nix-rollback-verified');
    expect(pinnedRestart).toContain('previous Nix generation verified and promoted current');
    expect(pinnedRestart).toContain('host-rollback-verified');
    expect(pinnedRestart).not.toContain('git fetch');
    expect(pinnedRestart).not.toContain('git push');
    expect(pinnedRestart).not.toContain('nix build');
    expect(pinnedRestart).not.toContain('fleet-nix-prefetch');
  });

  it('rehearses detached lifecycle survival and injected rollback off production ports', () => {
    expect(cutoverRehearsal).toContain("s.bind(('127.0.0.1', 0))");
    expect(cutoverRehearsal).toContain('setsid nohup');
    expect(cutoverRehearsal).toContain('detached runner survived caller exit');
    expect(cutoverRehearsal).toContain('injected candidate verification failure');
    expect(cutoverRehearsal).toContain('rollback-verified');
    expect(cutoverRehearsal).not.toContain('tower-prod');
    expect(cutoverRehearsal).not.toContain('32364');
  });

  it('can run the real closure under a non-authority PM2 process for lifecycle rehearsal', () => {
    expect(fullBackendCanary).toContain('TOWER_CANARY_USE_PM2');
    expect(fullBackendCanary).toContain('PM2_HOME="$pm2_home" pm2 start "$app_root/bin/tower-app-start-production"');
    expect(fullBackendCanary).toContain('PM2_HOME="$pm2_home" pm2 delete "$pm2_name"');
    expect(fullBackendCanary).toContain('TOWER_NIX_PRODUCTION_PROFILE=canary');
  });

  it('keeps private +N versions while public exports use explicit release metadata', () => {
    expect(flake).toContain('publicRelease = if builtins.pathExists ./PUBLIC_RELEASE.json');
    expect(flake).toContain('then builtins.fromJSON (builtins.readFile ./PUBLIC_RELEASE.json)');
    expect(flake).toContain('releaseChannel = if publicRelease != null');
    expect(flake).toContain('releaseBaseVersion = if publicRelease != null');
    expect(flake).toContain('then publicRelease.version');
    expect(flake).toContain('else "1.70.43"');
    expect(flake).toContain('releaseBaseRevCount = 2186');
    expect(flake).toContain('sourceRevCount = self.revCount or releaseBaseRevCount');
    expect(flake).toContain('then publicRelease.commitsSinceRelease or 0');
    expect(flake).toContain('else sourceRevCount - releaseBaseRevCount');
    expect(flake).toContain('then "${releaseBaseVersion}+${toString releaseCommitsSinceTag}"');
    expect(flake).toContain('releaseId = if publicRelease != null');
    expect(flake).not.toContain('releaseCommitsSinceTag = null');
    expect(flake).not.toContain('releaseVersion = "1.70.42"');
  });

  it('bundles the signed analysis Python runtime used by PDF, spreadsheet, and CAD tools', () => {
    expect(flake).toContain('towerAnalysisPython = pkgs.python3.withPackages');
    for (const dependency of ['pymupdf', 'pdfplumber', 'pillow', 'pandas', 'numpy', 'openpyxl', 'matplotlib', 'ezdxf']) {
      expect(flake).toContain(dependency);
    }
    expect(flake).toContain('pkgs.nodejs_22 towerAnalysisPython pkgs.coreutils');
    expect(flake).toContain('--set TOWER_DOCUMENT_PYTHON');
    expect(flake).toContain('--set TOWER_CAD_PYTHON');
    expect(flake).toContain('"$out/bin/tower-app-document-smoke"');
    expect(flake).toContain('cp ${./scripts/nix-app/tower-app-deploy-verify} "$out/bin/tower-app-deploy-verify"');
    expect(flake).toContain('cp scripts/deploy-verify.mjs "$app/scripts/deploy-verify.mjs"');
    expect(flake).toContain('cp scripts/deploy-verify-lib.mjs "$app/scripts/deploy-verify-lib.mjs"');
    expect(flake).toContain('test -x "$out/bin/tower-app-deploy-verify"');
    expect(flake).toContain('--set TOWER_APP_ROOT "$out"');
    expect(flake).not.toContain('tower-app-runtime-box-smoke');
    expect(flake).not.toContain('pkgs.docker-client pkgs.coreutils pkgs.bash pkgs.util-linux');
  });

  it('makes the packaged Nix renderer an app-closure dependency and ignores stale host renderer env', () => {
    expect(flake).toContain('ln -s ${towerNixRender}/bin/tower-nix-render "$out/bin/tower-nix-render"');
    expect(flake).toMatch(/towerNixRender = pkgs\.writeShellApplication[\s\S]*?pkgs\.which/);
    expect(flake).toContain('--set PDF_EXPORT_RENDERER_MODE nix');
    expect(flake).toContain('--set NIX_RENDERER_BIN "$out/bin/tower-nix-render"');
    expect(flake).toContain('"$out/bin/tower-app-pdf-smoke"');
    expect(launcher).toContain('missing integrated Nix PDF renderer');
    expect(launcher).toContain('export PDF_EXPORT_RENDERER_MODE=nix');
    expect(launcher).toContain('export NIX_RENDERER_BIN="$renderer_bin"');
    expect(pdfSmoke).toContain("result.requested !== 'nix'");
    expect(pdfSmoke).toContain("result.used !== 'nix'");
    expect(pdfSmoke).toContain('result.fallback');
    expect(pdfSmoke).toContain('process.stdout.write = process.stderr.write.bind(process.stderr)');
    expect(pdfSmoke).toContain('process.stdout.write = originalStdoutWrite');
    expect(productionUpgrade).toContain('env -u PDF_EXPORT_RENDERER_MODE -u NIX_RENDERER_BIN NODE_ENV=production TOWER_DEPLOYMENT_ID=production "$store/bin/tower-app-pdf-smoke"');
  });

  it('injects authoritative packaged release identity', () => {
    expect(launcher).toContain('share/tower/release-manifest.json');
    expect(launcher).toContain('conflicts with release manifest');
    for (const envName of [...PACKAGED_RELEASE_REQUIRED_ENV, ...PACKAGED_RELEASE_OPTIONAL_ENV]) {
      expect(launcher).toContain(envName);
    }
  });
});
