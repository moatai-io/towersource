import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../scripts/fleet/fleet-shared-project-worker', import.meta.url), 'utf8');

describe('Fleet shared Project Worker rollout', () => {
  it('uses the current signed closure and one VM-level Worker scope', () => {
    expect(source).toContain('TOWER_SHARED_WORKER_MAX_RUNS:-20');
    expect(source).toContain('TOWER_LOCAL_WORKER_MAX_RUNS="$worker_max_runs"');
    expect(source).toContain('.tower-nix-cache/gcroots/current');
    expect(source).toContain('install-system-workbench-worker-units');
    expect(source).toContain('TOWER_LOCAL_WORKER_PROJECT_IDS="$ids"');
    expect(source).not.toContain('chown -R');
  });

  it('fails closed on the full host and Project preflight before any migration mutation', () => {
    const gate = source.indexOf('"$install_preflight" "${preflight_args[@]}"');
    expect(gate).toBeGreaterThan(0);
    expect(source).toContain('tower-shared-worker-install-preflight');
    expect(source).toContain('preflight_args=(--env-file "$env_file" --closure "$closure" --worker-user tower-worker)');
    expect(source).toContain('preflight_args+=(--root "$root")');
    expect(source).toContain('tower-shared-worker-host-policy');
    expect(source).toContain('"$host_policy" inspect');
    expect(source).toContain('"$host_policy" ensure');
    expect(source).toContain('shared Worker install preflight blocked');
    expect(source).not.toContain('chmod g+rwxs');
    expect(source).not.toContain('usermod -a');
    expect(source).not.toContain('useradd --system');
    for (const mutation of ['install -d', 'bootstrap-system-workbench-worker-credentials.js', 'systemctl restart', 'applyProjectWorkstationChange']) {
      expect(gate).toBeLessThan(source.indexOf(mutation));
    }
  });

  it('expands Worker identity to all active Projects before startup', () => {
    expect(source).toContain('issueWorkbenchWorkerIdentity');
    expect(source).toContain('rotateWorkbenchWorkerIdentity');
    expect(source).toContain("capabilities:['job','service','shell']");
    expect(source).toContain("expiresIn:'30d'");
  });

  it('reconciles existing bindings and activates only missing Projects binding-last', () => {
    expect(source).toContain('activeProjects.has(row.projectId)');
    expect(source).toContain('Reconcile rollout for an already active shared Worker binding');
    expect(source).toContain('previewProjectWorkstationChange');
    expect(source).toContain('verifyProjectWorkstationChangeSmoke');
    expect(source).toContain('applyProjectWorkstationChange');
    expect(source).toContain('smokeReceiptHash:smoke.receiptHash');
    expect(source).toContain('setWorkbenchRollout');
    expect(source).toContain("status:'enabled'");
    expect(source).not.toContain('INSERT INTO project_compute_deployment_bindings');
  });

  it('persists Worker-required execution and starts the system assignment reconciler', () => {
    expect(source).toContain("'TOWER_PRIMARY_WORKER_ID': worker");
    expect(source).toContain("'ENABLE_RUNTIME_BOX_COMPATIBILITY': 'false'");
    expect(source).toContain("'TOWER_WORKER_SIGNED_EXECUTION_GRANTS': 'true'");
    expect(source).toContain('install-workbench-assignment-reconciler-unit');
    expect(source).toContain('TOWER_ASSIGNMENT_SERVICE_MANAGER=system');
    expect(source).toContain('systemctl enable --now tower-workbench-assignment-reconciler.timer');
    expect(source).toContain('os.chown(t,metadata.st_uid,metadata.st_gid)');
    expect(source).toContain('stat.S_IMODE(metadata.st_mode)');
  });

  it('requires running Backend environment, binding and heartbeat invariants before reporting success', () => {
    expect(source).toContain('BACKEND_PRIMARY_WORKER_ENV_STALE');
    expect(source).toContain('BACKEND_RUNTIME_BOX_COMPATIBILITY_ENV_STALE');
    expect(source).toContain('BACKEND_SIGNED_GRANT_ENV_STALE');
    expect(source).toContain('PROJECT_WORKER_BINDING_INVARIANT_FAILED');
    expect(source).toContain('WORKER_HEARTBEAT_INVARIANT_FAILED');
    expect(source).toContain("EXTRACT(EPOCH FROM (NOW()-heartbeat_at))<30");
  });
});
