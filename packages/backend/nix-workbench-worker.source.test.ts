import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const flake = fs.readFileSync(path.join(root, 'flake.nix'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'scripts/nix-app/tower-workbench-worker'), 'utf8');
const heartbeat = fs.readFileSync(path.join(root, 'scripts/nix-app/tower-workbench-worker-heartbeat'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'scripts/nix-app/install-local-workbench-worker-units'), 'utf8');
const systemInstaller = fs.readFileSync(path.join(root, 'scripts/nix-app/install-system-workbench-worker-units'), 'utf8');
const systemBootstrap = fs.readFileSync(path.join(root, 'packages/backend/scripts/bootstrap-system-workbench-worker-credentials.ts'), 'utf8');
const heartbeatSource = fs.readFileSync(path.join(root, 'packages/backend/scripts/local-workbench-worker-heartbeat.ts'), 'utf8');
const assignmentLauncher = fs.readFileSync(path.join(root, 'scripts/nix-app/tower-workbench-assignment-reconciler'), 'utf8');
const assignmentInstaller = fs.readFileSync(path.join(root, 'scripts/nix-app/install-workbench-assignment-reconciler-unit'), 'utf8');
const assignmentSource = fs.readFileSync(path.join(root, 'packages/backend/scripts/reconcile-primary-worker-assignment.ts'), 'utf8');
const baselineManifest = JSON.parse(fs.readFileSync(path.join(root, 'packages/backend/project-compute-baseline.json'), 'utf8'));
const nixDoctor = fs.readFileSync(path.join(root, 'scripts/nix-app/runtime-compute-doctor'), 'utf8');

describe('Nix-packaged production Workbench Worker', () => {
  it('ships Worker, heartbeat, and assignment reconciler launchers in the immutable closure', () => {
    for (const name of ['tower-workbench-worker', 'tower-workbench-worker-heartbeat', 'install-local-workbench-worker-units', 'install-system-workbench-worker-units', 'tower-workbench-assignment-reconciler', 'install-workbench-assignment-reconciler-unit']) {
      expect(flake).toContain(`$out/bin/${name}`);
      expect(flake).toContain(`test -x "$out/bin/${name}"`);
    }
    expect(worker).toContain('remote-workbench-worker-entrypoint.js');
    expect(heartbeat).toContain('local-workbench-worker-heartbeat.js');
    expect(flake).toContain('pkgs.bubblewrap');
    expect(flake).toContain('TOWER_WORKER_BWRAP_BIN');
    expect(systemInstaller).toContain('UMask=0002');
    expect(systemInstaller).toContain('repair_project_permissions="${TOWER_REPAIR_PROJECT_PERMISSIONS:-false}"');
    expect(systemInstaller).toContain('if [[ "$repair_project_permissions" == "true" ]]');
    expect(systemInstaller).toContain('recursive permission repair is retired');
    expect(systemInstaller).not.toContain('"$permission_gate"');
    expect(systemInstaller).not.toContain('inspect --roots-only');
    expect(systemInstaller).toContain('runuser -u "$execution_user" -- test -x "$project_root"');
    expect(systemInstaller).not.toContain('chmod g+');
    expect(systemInstaller).not.toContain('setfacl -m');
    expect(flake).toContain('test -x "$out/bin/tower-worker-permission-preflight"');
    expect(systemInstaller).not.toContain('chown -R');
    expect(assignmentLauncher).toContain('reconcile-primary-worker-assignment.js');
  });

  it('packages the Python preflight with an executable patched entrypoint and runtime dependency', () => {
    expect(flake).toContain('nativeBuildInputs = [ npm10Node22 pkgs.nodejs_22 pkgs.makeWrapper pkgs.python3 ]');
    expect(flake).toContain('cp ${./scripts/nix-app/tower-worker-permission-preflight} "$out/bin/tower-worker-permission-preflight"');
    expect(flake).toContain('chmod +x "$out/bin/tower-worker-permission-preflight"');
    expect(flake).toContain('patchShebangs "$out/bin/tower-worker-permission-preflight"');
    expect(flake).toMatch(/wrapProgram "\$out\/bin\/tower-worker-permission-preflight"\s*\\\s*--prefix PATH : \$\{lib\.makeBinPath \[ pkgs\.python3 \]\}/);
  });

  it('installs a disabled-by-default one-shot assignment timer for user or system Workers', () => {
    expect(assignmentInstaller).toContain('OnUnitActiveSec=30s');
    expect(assignmentInstaller).toContain('Type=oneshot');
    expect(assignmentInstaller).toContain('systemctl_prefix=(systemctl --user)');
    expect(assignmentInstaller).toContain('systemctl_prefix=(systemctl)');
    expect(assignmentInstaller).toContain('"${systemctl_prefix[@]}" enable tower-workbench-assignment-reconciler.timer');
    expect(assignmentInstaller).not.toContain('"${systemctl_prefix[@]}" start');
  });

  it('keeps Project binding activation after Worker preparation and smoke', () => {
    expect(assignmentSource.indexOf('await installAndRestart(nextProjects)')).toBeLessThan(assignmentSource.indexOf('verifyWorker:'));
    expect(assignmentSource.indexOf('verifyWorker:')).toBeLessThan(assignmentSource.indexOf('activateBinding:'));
    expect(assignmentSource).toContain('PROJECT_ROOT_NOT_STANDARD');
    expect(assignmentSource).not.toContain('console.log(issued.token');
  });

  it('requires operator-owned config, identity, and transport token inputs', () => {
    expect(worker).toContain('TOWER_REMOTE_WORKER_CONFIG is required');
    expect(worker).toContain('TOWER_REMOTE_WORKER_TOKEN is required');
    expect(heartbeat).toContain('TOWER_LOCAL_WORKER_IDENTITY_FILE');
    expect(installer).toContain('Worker config missing');
    expect(installer).toContain('Worker transport env missing');
    expect(installer).toContain('Worker identity missing');
  });

  it('installs production-scoped per-Worker units without automatically starting or activating Projects', () => {
    expect(installer).toContain('TOWER_LOCAL_WORKER_DEPLOYMENT_ID=$deployment_id');
    expect(installer).toContain('deployment_id="${TOWER_LOCAL_WORKER_DEPLOYMENT_ID:-production}"');
    expect(installer).toContain('unit_prefix="tower-prod-workbench-worker-${worker_id#tower-prod-local-}"');
    expect(installer).toContain('systemctl --user enable "$worker_unit_name" "$heartbeat_unit_name"');
    expect(installer).not.toContain('systemctl --user start');
    expect(installer).not.toContain('project_compute_settings');
    expect(installer).toContain('"started":false');
  });

  it('rejects retired operator-plane Workers in favor of native Operator access', () => {
    expect(installer).toContain('Worker authority must be project; Operator access uses the native Operator execution environment');
    expect(installer).not.toContain("worker_capabilities='job,service,shell,operator-plane'");
    expect(installer).not.toContain('tower-operator-workbench-worker');
    expect(installer).not.toContain("'/workspace/tower': towerSource");
    expect(installer).not.toContain("'/workspace/workspace': workspaceRoot");
    expect(installer).not.toContain('Environment=TOWER_WORKER_BWRAP_BIN=');
    expect(flake).toContain('pkgs.nodejs_22 pkgs.coreutils pkgs.systemd');
  });

  it('installs an opt-in system Worker under a separate execution user and slice', () => {
    expect(systemInstaller).toContain('execution_user="${TOWER_EXECUTION_USER:-tower-worker}"');
    expect(systemInstaller).toContain('[[ "${EUID:-$(id -u)}" -eq 0 ]]');
    expect(systemInstaller).toContain('User=$execution_user');
    expect(systemInstaller).toContain('Group=$execution_group');
    expect(systemInstaller).toContain('Slice=tower-execution.slice');
    expect(systemInstaller).toContain('runuser -u "$execution_user" -- test -w "$project_root"');
    expect(systemInstaller).toContain('runuser -u "$execution_user" -- test -r "$managed_skills_root"');
    expect(systemInstaller).toContain('permissionRepair');
    expect(systemInstaller).toContain('systemctl enable "$worker_unit_name" "$heartbeat_unit_name"');
    expect(systemInstaller).not.toContain('systemctl start');
    expect(systemInstaller).not.toMatch(/chown\s+-R/);
    expect(flake).toContain('pkgs.shadow');
  });

  it('keeps system-user Workstations project-scoped', () => {
    expect(systemInstaller).toContain('Worker authority must be project; Operator access uses the native Operator execution environment');
    expect(systemInstaller).not.toContain('Operator Worker capabilities must include operator-plane');
    expect(systemInstaller).not.toContain("'/workspace/tower', '/workspace/workspace'");
    expect(systemBootstrap).not.toContain("...(authorityMode === 'operator-plane' ? ['operator-plane'] : [])");
    expect(systemBootstrap).not.toContain("'/workspace/tower': path.resolve(operatorTowerSource!)");
    expect(systemBootstrap).not.toContain('operatorGitIdentity');
    expect(systemBootstrap).toContain('managedSkillsRoot');
    expect(systemBootstrap).toContain('runtimeProvenance');
    expect(systemBootstrap).toContain('TOWER_SOURCE_REV');
    expect(systemBootstrap).toContain('TOWER_APP_ROOT');
    expect(systemBootstrap).toContain("path.join(path.dirname(projectRoot), 'teamskills')");
  });

  it('keeps all Local Workers inside one host-protecting resource slice', () => {
    expect(installer).toContain('slice_unit="$unit_dir/tower-workers.slice"');
    expect(installer).toContain('CPUQuota=$worker_pool_cpu_quota');
    expect(installer).toContain('MemoryHigh=$worker_pool_memory_high');
    expect(installer).toContain('MemoryMax=$worker_pool_memory_max');
    expect(installer).toContain('TasksMax=$worker_pool_tasks_max');
    expect(installer).toContain('Slice=tower-workers.slice');
    expect(installer).toContain('MemoryMax=$worker_memory_max');
  });

  it('defaults every installed Worker to twenty capacity units while preserving explicit overrides', () => {
    expect(installer).toContain('worker_max_runs="${TOWER_LOCAL_WORKER_MAX_RUNS:-20}"');
    expect(installer).toContain('TOWER_LOCAL_WORKER_MAX_RUNS must be at least 3 capacity units');
    expect(systemInstaller).toContain('worker_max_runs="${TOWER_LOCAL_WORKER_MAX_RUNS:-20}"');
    expect(systemBootstrap).toContain("TOWER_BOOTSTRAP_MAX_RUNS?.trim() || '20'");
    expect(systemBootstrap).toContain('maxRuns < 3');
    expect(installer).toContain('Environment=TOWER_LOCAL_WORKER_MAX_RUNS=$worker_max_runs');
    expect(heartbeatSource).toContain('TOWER_LOCAL_WORKER_MAX_RUNS ?? 20');
    expect(heartbeatSource).toContain('maxRuns }');
    expect(heartbeatSource).not.toContain('maxRuns: 20');
  });

  it('ships one manifest-driven authoritative Worker compute baseline', () => {
    expect(flake).toContain('workerBaseline = [');
    expect(flake).toContain('pkgs.bubblewrap');
    expect(flake).toContain('TOWER_WORKER_BWRAP_BIN');
    expect(flake).toContain('pkgs.python313.withPackages');
    expect(flake).toContain('pkgs.libreoffice-fresh');
    expect(flake).toContain('pkgs.typst');
    expect(flake).toContain('workerPandoc');
    expect(flake).toContain('version = "3.10"');
    expect(flake).toContain('sha256-4PivYtDyZ9IrqlvO/m1d2joJfMxg3nlLdZ/gMVmSMkQ=');
    expect(flake).toContain('pkgs.chromium');
    expect(flake).toContain('pkgs.util-linux');
    expect(flake).toContain('pkgs.uv');
    expect(flake).toContain('workerPublishingTools');
    expect(flake).toContain('tower-html-render');
    for (const fontPackage of ['pkgs.noto-fonts-cjk-serif', 'pkgs.nanum-gothic-coding', 'pkgs.dejavu_fonts', 'pkgs.liberation_ttf']) {
      expect(flake).toContain(fontPackage);
    }
    expect(flake).toContain('compute-baseline.json');
    expect(flake).toContain('runtime-compute-doctor');
    expect(flake).toContain('wrapProgram "$out/bin/tower-workbench-worker"');
    expect(flake).toContain('--prefix PATH : "$out/bin"');
    expect(nixDoctor).toContain('TOWER_COMPUTE_BASELINE_MANIFEST');
    expect(baselineManifest.commands.core).toContain('git');
    expect(baselineManifest.commands.documents).toContain('libreoffice');
    expect(baselineManifest.pythonImports).toContain('openpyxl');
    expect(baselineManifest.ocrLanguages).toEqual(['eng', 'kor']);
    expect(baselineManifest.commands.publishing).toEqual(['mmdc', 'marp', 'svgo', 'tower-html-render']);
    expect(baselineManifest.nodeImports).toEqual(['playwright-core']);
    expect(flake).toContain('--set NODE_PATH');
    expect(baselineManifest.fontFamilies).toContain('Noto Serif CJK KR');
    expect(baselineManifest.genericFontFamilies).toMatchObject({
      'sans-serif': expect.any(String),
      serif: expect.any(String),
      monospace: expect.any(String),
    });
    expect(nixDoctor).toContain("fc-match -f '%{family}\\n'");
    expect(nixDoctor).toContain('.genericFontFamilies');
  });

  it('keeps the heartbeat event loop referenced instead of relying on unsettled top-level await', () => {
    expect(heartbeatSource).toContain('setInterval(() =>');
    expect(heartbeatSource).not.toContain('.unref()');
    expect(heartbeatSource).not.toContain('new Promise<void>(() => {})');
  });
});
