import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/scripts/reconcile-primary-worker-assignment.ts'), 'utf8');

describe('primary Worker assignment activation source', () => {
  it('uses the atomic Worker-first activation service after the assignment lease check', () => {
    expect(source).toContain('activateProjectWorkerFirstWithClient');
    expect(source).toContain("rolloutCohort: 'primary-worker-assignment'");
    expect(source).not.toContain('INSERT INTO project_compute_deployment_bindings');
  });

  it('does not resurrect expired identity or call an installer on the legacy path', () => {
    expect(source).not.toContain('async function rotateIdentity(');
    expect(source).not.toContain('async function installAndRestart(');
    expect(source).not.toContain('await recordWorkbenchWorkerIdentity(');
    expect(source).not.toContain('await rotateWorkbenchWorkerIdentity(');
    expect(source).not.toContain("await run('systemctl'");
    expect(source).toContain('TOWER_ASSIGNMENT_WORKER_PORT');
  });

  it('uses signed execution grants only for command routing, never as static file authority', () => {
    expect(source).toContain("TOWER_WORKER_SIGNED_EXECUTION_GRANTS === 'true'");
    expect(source).not.toContain('if (signedGrantMode) return { rollback: async () => {} }');
    expect(source).toContain('createRemoteWorkbenchHttpTransport');
    expect(source).toContain('projectRoot: root');
    expect(source).toContain('fileAuthorityReady: !signedGrantMode');
  });

  it('requires static file scope even when signed execution grants are enabled', () => {
    expect(source).toContain('const scopeReady = worker?.projectIds.includes(assignment.project_id)');
    expect(source).not.toContain('signedGrantMode || worker?.projectIds');
    expect(source).toContain("throw new Error('PRIMARY_WORKER_HEARTBEAT_SCOPE_TIMEOUT')");
  });

  it('requires a Worker file round-trip before binding activation', () => {
    expect(source).toContain('assignment-file-roundtrip-ok');
    expect(source).toContain('test "$(pwd)" = /workspace || test "$(pwd)" = ${JSON.stringify(root)}');
    expect(source).toContain('claimProjectWorkerAssignment({ deploymentId, workerId,');
    expect(source).toContain('PRIMARY_WORKER_ASSIGNMENT_FILE_SMOKE_FAILED');
    expect(source).toContain("verificationEvidence: 'worker-file-roundtrip'");
    expect(source.indexOf('assignment-file-roundtrip-ok')).toBeLessThan(source.indexOf('async function activate('));
  });

  it('backfills active standard Projects only when explicitly enabled', () => {
    expect(source).toContain("TOWER_ASSIGNMENT_AUTO_BACKFILL === 'true'");
    expect(source).toContain('automaticBackfill ? await queueMissingAssignments() : 0');
    expect(source).toContain('requestProjectWorkerAssignment');
    expect(source).toContain("NULLIF(BTRIM(COALESCE(p.system_key,'')),'') IS NULL");
    expect(source).toContain('Automatic backfill for active Project without primary Worker binding');
  });

  it('preserves prepared config by not rewriting it; missing scope delegates before claim', () => {
    expect(source).not.toContain('atomicWrite(');
    expect(source).not.toContain('fs.writeFileSync(');
    expect(source).not.toContain('fs.renameSync(');
    expect(source).toContain("if(originalConfig.projects[assignment.project_id]!==target.root)throw new Error('SCOPE_DEDICATED_COORDINATOR_REQUIRED')");
    expect(source).toContain('return {rollback:async()=>{}};');
    const main = source.slice(source.indexOf('async function main()'));
    const selection = main.indexOf('const pending =');
    const refusal = main.indexOf("reason:'SCOPE_DEDICATED_COORDINATOR_REQUIRED'");
    const claim = main.indexOf('await claimProjectWorkerAssignment(');
    expect(selection).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(selection);
    expect(claim).toBeGreaterThan(refusal);
    expect(main.slice(selection,claim)).toContain('mutatedWorker:false}));return;');
    expect(main.slice(selection,claim)).toContain('if(pending)');
    expect(main.slice(selection,claim)).not.toContain('if(pending && !signedGrantMode)');
  });

  it('does not change protected file metadata on the no-mutation path', () => {
    expect(source).not.toContain('fs.chownSync(');
    expect(source).not.toContain('fs.chmodSync(');
    const required = source.slice(source.indexOf('function requiredFiles()'),source.indexOf('async function project('));
    expect(required).toContain('if (signedGrantMode) return;');
    expect(required).toContain('for (const file of [configFile, identityFile])');
    expect(required).not.toContain('TOWER_ASSIGNMENT_WORKER_INSTALLER_REQUIRED');
  });

  it('closes the PostgreSQL pool so recurring oneshot services terminate', () => {
    expect(source).toContain("import { closePgPool } from '../db/pg.js'");
    expect(source).toContain('.finally(() => closePgPool())');
  });
});

// Exercise the actual generated shell guard, not just a matching source string.
describe('assignment cwd guard shell behavior', () => {
  it('accepts the native root and refuses a different directory before writes', () => {
    const line = source.split('\n').find(line => line.includes('test "$(pwd)" = /workspace ||'))!;
    const template = line.slice(line.indexOf('`') + 1, line.lastIndexOf('`'));
    const root = fs.mkdtempSync(path.join(process.cwd(), 'work-cwd-test-'));
    try {
      const guard = template.replace('${JSON.stringify(root)}', JSON.stringify(root));
      const command = `set -e; ${guard} && printf passed`;
      expect(execFileSync('sh', ['-c', command], { cwd: root, encoding: 'utf8' })).toBe('passed');
      const rejected = spawnSync('sh', ['-c', command], { cwd: path.dirname(root), encoding: 'utf8' });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe('');
    } finally { fs.rmdirSync(root); }
  });
});

describe('system assignment target parity', () => {
  it('routes before opening SH and never starts a scope mutator under inherited SH', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'scripts/nix-app/tower-workbench-assignment-reconciler'), 'utf8');
    const route=launcher.indexOf('node "$route_entry"');
    const shared=launcher.indexOf('exec 197<');
    const legacy=launcher.indexOf('exec node "$entrypoint"');
    expect(route).toBeGreaterThan(-1);expect(shared).toBeGreaterThan(route);expect(legacy).toBeGreaterThan(shared);
    expect(launcher).toContain('worker-scope-assignment-routing.js');
    expect(launcher).toContain('21) exit 0');
    expect(launcher).toContain("fail 'assignment route blocked; no installer fallback'");
    expect(launcher).not.toContain('systemctl start');
    expect(launcher).not.toContain('worker-scope-cli.js');
  });
  it('selects the system installer and supplies its closure root', () => {
    const launcher = fs.readFileSync(path.join(process.cwd(), 'scripts/nix-app/tower-workbench-assignment-reconciler'), 'utf8');
    expect(launcher).toContain('system) default_installer="$app_root/bin/install-system-workbench-worker-units"');
    expect(launcher).toContain('export TOWER_APP_ROOT="$app_root"');
    expect(launcher).toContain("fail 'invalid assignment service manager'");
  });
});

describe('claimed input preflight termination', () => {
  it('records invalid input failure before Worker preparation and checks lease ownership', () => {
    const start = source.indexOf('let target: { root: string }');
    const finish = source.indexOf('const nextProjects', start);
    const block = source.slice(start, finish);
    expect(block).toContain('await project(assignment.project_id)');
    expect(block).toContain('ASSIGNMENT_EXISTING_BINDING_REQUIRES_EXPLICIT_CHANGE');
    expect(block).toContain('await failProjectWorkerAssignment');
    expect(block).toContain('leaseOwner: assignment.lease_owner!');
    expect(block).toContain('ASSIGNMENT_PREFLIGHT_LEASE_LOST');
    expect(block).toContain('mutatedWorker: false');
    expect(block).not.toContain('rotateIdentity(');
    expect(block).not.toContain('installAndRestart(');
  });
});
