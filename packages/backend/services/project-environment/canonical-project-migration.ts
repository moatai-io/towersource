import { migrationProjectPeerAcl } from '../pm/project-peer-acl.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { query, transaction, withClient } from '../../db/pg-repo.js';
import { readNewProjectStoragePolicy, type NewProjectStoragePolicy } from '../pm/new-project-storage-policy.js';
import { resolveNewProjectAclExecutable } from '../pm/new-project-acl-executable.js';
import { selectProjectExecutionProvider } from '../execution/executor-selector.js';
import { executeWorkbenchRequest } from '../execution/execution-broker.js';

export interface CanonicalProjectMigrationProject {
  id: string;
  name: string;
  root_path: string;
  archived: number;
  lifecycle_status: string | null;
  system_key: string | null;
  storage_kind: 'host' | 'worker' | null;
  storage_worker_id: string | null;
  storage_state: 'pending' | 'ready' | 'blocked' | null;
  storage_version: number | null;
  owner_user_id: number;
}

export interface CanonicalProjectMigrationPath {
  path: string;
  relativePath: string;
  reason: 'worker-access-missing' | 'backend-access-missing' | 'default-inheritance-missing' | 'backend-default-inheritance-missing';
  dev: string;
  ino: string;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  accessAcl: string;
  defaultAcl: string;
}

export interface CanonicalProjectMigrationPlan {
  schemaVersion: 1;
  project: { id: string; name: string; root: string };
  deploymentId: string;
  policy: NewProjectStoragePolicy;
  storageAction: 'insert_host_ready' | 'no_action';
  aclChanges: CanonicalProjectMigrationPath[];
  preflight: { status: 'blocked'; scanned: number; blockingCount: number; excludedCount: number };
  createdAt: string;
  planHash: string;
}

interface PreflightFinding { path: string; reason: string; blocking: boolean }
interface PreflightReport {
  status: string;
  mutated: boolean;
  scanned: number;
  blockingCount: number;
  excludedCount: number;
  findingsTruncated?: boolean;
  findings: PreflightFinding[];
  repairCandidates: Array<{ path: string; reason: string }>;
}

export interface CanonicalProjectMigrationDeps {
  loadProject(projectId: string, deploymentId: string): Promise<CanonicalProjectMigrationProject | undefined>;
  readPolicy(): NewProjectStoragePolicy | undefined;
  runPreflight(root: string, workerUid: number, backendUid: number): PreflightReport;
  readAcl(target: string, kind: 'access' | 'default'): string;
  stat(target: string): fs.Stats;
  applyAcl(target: CanonicalProjectMigrationPath, policy: NewProjectStoragePolicy): void;
  restoreAcl(snapshotFile: string): void;
  verifyWorkerAccess(project: CanonicalProjectMigrationProject, deploymentId: string): Promise<void>;
  verifyBackendAccess(root: string, backendUid: number): void;
  persistHostBinding(projectId: string, deploymentId: string): Promise<void>;
  now(): Date;
}

const protectedNames = new Set(['.tower-run-credentials', '.tower-credentials', '.credentials', '.ssh', '.git', '.tower', '.claude', '.cache', 'node_modules', '.venv', 'venv']);
const allowedReasons = new Set(['worker-access-missing', 'backend-access-missing', 'default-inheritance-missing', 'backend-default-inheritance-missing']);
const stable = (value: unknown) => JSON.stringify(value);
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function fail(code: string): never { throw new Error(`CANONICAL_PROJECT_MIGRATION_${code}`); }

function assertDeploymentId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) fail('DEPLOYMENT_INVALID');
}

function assertProject(project: CanonicalProjectMigrationProject | undefined, policy: NewProjectStoragePolicy): asserts project is CanonicalProjectMigrationProject {
  if (!project) fail('PROJECT_NOT_FOUND');
  if (project.archived || (project.lifecycle_status ?? 'active') !== 'active' || project.system_key) fail('PROJECT_INELIGIBLE');
  const root = path.resolve(project.root_path);
  if (root !== project.root_path || !policy.projectParents.includes(path.dirname(root))) fail('ROOT_NOT_ALLOWED');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) fail('ROOT_UNTRUSTED');
  if (project.storage_kind === 'worker' || project.storage_worker_id) fail('LEGACY_WORKER_STORAGE_EXCLUDED');
  if (project.storage_kind && (project.storage_kind !== 'host' || project.storage_state !== 'ready')) fail('STORAGE_CONFLICT');
}

function assertCandidate(root: string, candidate: { path: string; reason: string }): void {
  if (!allowedReasons.has(candidate.reason)) fail('PREFLIGHT_UNSUPPORTED_FINDING');
  const resolved = path.resolve(candidate.path);
  if (resolved !== candidate.path || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) fail('CANDIDATE_OUTSIDE_ROOT');
  const rel = path.relative(root, resolved);
  if (rel.split(path.sep).some(part => protectedNames.has(part))) fail('PROTECTED_PATH');
}

function planIdentity(plan: Omit<CanonicalProjectMigrationPlan, 'planHash'>): string {
  return digest(plan);
}

export async function planCanonicalProjectMigration(
  input: { projectId: string; deploymentId?: string },
  deps: CanonicalProjectMigrationDeps = defaultDeps,
): Promise<CanonicalProjectMigrationPlan> {
  const deploymentId = input.deploymentId ?? 'production';
  assertDeploymentId(deploymentId);
  const policy = deps.readPolicy();
  if (!policy) fail('POLICY_REQUIRED');
  const project = await deps.loadProject(input.projectId, deploymentId);
  assertProject(project, policy);
  const report = deps.runPreflight(project.root_path, policy.workerUid, policy.backendUid);
  if (report.mutated || report.status !== 'blocked' || report.findingsTruncated) fail('PREFLIGHT_UNUSABLE');
  const blocking = report.findings.filter(finding => finding.blocking);
  if (!blocking.length || blocking.some(finding => !allowedReasons.has(finding.reason))) fail('PREFLIGHT_UNSUPPORTED_FINDING');
  const unique = new Map<string, { path: string; reason: string }>();
  for (const candidate of report.repairCandidates) {
    assertCandidate(project.root_path, candidate);
    const current = unique.get(candidate.path);
    unique.set(candidate.path, { path: candidate.path, reason: current?.reason === 'worker-access-missing' ? current.reason : candidate.reason as CanonicalProjectMigrationPath['reason'] });
  }
  if (!unique.size || blocking.some(finding => !unique.has(finding.path))) fail('PREFLIGHT_CANDIDATES_INCOMPLETE');
  const aclChanges = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path)).map(candidate => {
    const stat = deps.stat(candidate.path);
    if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) fail('CANDIDATE_UNTRUSTED');
    return {
      path: candidate.path,
      relativePath: path.relative(project.root_path, candidate.path) || '.',
      reason: candidate.reason as CanonicalProjectMigrationPath['reason'],
      dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode, uid: stat.uid, gid: stat.gid, nlink: stat.nlink,
      accessAcl: deps.readAcl(candidate.path, 'access'),
      defaultAcl: stat.isDirectory() ? deps.readAcl(candidate.path, 'default') : '',
    };
  });
  const withoutHash: Omit<CanonicalProjectMigrationPlan, 'planHash'> = {
    schemaVersion: 1,
    project: { id: project.id, name: project.name, root: project.root_path },
    deploymentId,
    policy,
    storageAction: project.storage_kind === 'host' ? 'no_action' : 'insert_host_ready',
    aclChanges,
    preflight: { status: 'blocked', scanned: report.scanned, blockingCount: report.blockingCount, excludedCount: report.excludedCount },
    createdAt: deps.now().toISOString(),
  };
  return { ...withoutHash, planHash: planIdentity(withoutHash) };
}

function assertPlan(plan: CanonicalProjectMigrationPlan, approvedHash: string, deps: CanonicalProjectMigrationDeps): void {
  if (!/^[a-f0-9]{64}$/.test(approvedHash) || approvedHash !== plan.planHash) fail('APPROVAL_MISMATCH');
  const { planHash: _ignored, ...withoutHash } = plan;
  if (planIdentity(withoutHash) !== plan.planHash) fail('PLAN_TAMPERED');
  const policy = deps.readPolicy();
  if (!policy || stable(policy) !== stable(plan.policy)) fail('POLICY_CHANGED');
  const ageMs = deps.now().getTime() - Date.parse(plan.createdAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 30 * 60_000) fail('PLAN_EXPIRED');
}

function snapshotText(plan: CanonicalProjectMigrationPlan): string {
  return plan.aclChanges.map(change => {
    const header = `# file: ${change.path.replaceAll('\\', '\\\\').replaceAll('\n', '\\012')}\n# owner: ${change.uid}\n# group: ${change.gid}\n`;
    return `${header}${change.accessAcl}${change.defaultAcl ? `${change.defaultAcl}\n` : ''}\n`;
  }).join('');
}

export async function applyCanonicalProjectMigration(input: {
  plan: CanonicalProjectMigrationPlan;
  approvedHash: string;
  receiptDirectory: string;
}, deps: CanonicalProjectMigrationDeps = defaultDeps): Promise<{ status: 'verified'; receipt: string; projectId: string; planHash: string }> {
  assertPlan(input.plan, input.approvedHash, deps);
  const receiptDir = path.resolve(input.receiptDirectory);
  const stat = fs.lstatSync(receiptDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) fail('RECEIPT_DIRECTORY_UNTRUSTED');
  const current = await deps.loadProject(input.plan.project.id, input.plan.deploymentId);
  assertProject(current, input.plan.policy);
  if (current.root_path !== input.plan.project.root) fail('PROJECT_CHANGED');
  for (const change of input.plan.aclChanges) {
    const now = deps.stat(change.path);
    if (String(now.dev) !== change.dev || String(now.ino) !== change.ino || now.mode !== change.mode || now.uid !== change.uid || now.gid !== change.gid || now.nlink !== change.nlink
      || deps.readAcl(change.path, 'access') !== change.accessAcl || (now.isDirectory() ? deps.readAcl(change.path, 'default') : '') !== change.defaultAcl) fail('STALE_PLAN');
  }
  const operationId = randomUUID();
  const snapshot = path.join(receiptDir, `${operationId}.acl`);
  const receipt = path.join(receiptDir, `${operationId}.json`);
  fs.writeFileSync(snapshot, snapshotText(input.plan), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, operationId, status: 'applying', planHash: input.plan.planHash, projectId: input.plan.project.id, snapshot }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    for (const change of input.plan.aclChanges) deps.applyAcl(change, input.plan.policy);
    await deps.verifyWorkerAccess(current, input.plan.deploymentId);
    deps.verifyBackendAccess(input.plan.project.root, input.plan.policy.backendUid);
    if (input.plan.storageAction === 'insert_host_ready') await deps.persistHostBinding(input.plan.project.id, input.plan.deploymentId);
    fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, operationId, status: 'verified', planHash: input.plan.planHash, projectId: input.plan.project.id, snapshot, verifiedAt: deps.now().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
    return { status: 'verified', receipt, projectId: input.plan.project.id, planHash: input.plan.planHash };
  } catch (error) {
    try { deps.restoreAcl(snapshot); } catch (rollbackError) {
      fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, operationId, status: 'rollback_failed', planHash: input.plan.planHash, projectId: input.plan.project.id, snapshot, error: String(error), rollbackError: String(rollbackError) }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fail('ROLLBACK_FAILED');
    }
    fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, operationId, status: 'rolled_back', planHash: input.plan.planHash, projectId: input.plan.project.id, snapshot, error: String(error) }, null, 2), { encoding: 'utf8', mode: 0o600 });
    throw error;
  }
}

export const defaultDeps: CanonicalProjectMigrationDeps = {
  async loadProject(projectId, deploymentId) {
    return (await query<CanonicalProjectMigrationProject>(
      `SELECT p.id,p.name,p.root_path,p.archived,p.lifecycle_status,p.system_key,p.user_id AS owner_user_id,
              s.storage_kind,s.worker_id AS storage_worker_id,s.state AS storage_state,s.version AS storage_version
         FROM projects p LEFT JOIN project_file_storage_bindings s ON s.project_id=p.id AND s.deployment_id=$2
        WHERE p.id=$1`, [projectId, deploymentId]))[0];
  },
  readPolicy: () => readNewProjectStoragePolicy(),
  runPreflight(root, workerUid, backendUid) {
    const user = execFileSync('/usr/bin/getent', ['passwd', String(workerUid)], { encoding: 'utf8', timeout: 5000 }).split(':')[0];
    if (!user) fail('WORKER_IDENTITY_MISSING');
    const backendUser = execFileSync('/usr/bin/getent', ['passwd', String(backendUid)], { encoding: 'utf8', timeout: 5000 }).split(':')[0];
    if (!backendUser) fail('BACKEND_IDENTITY_MISSING');
    const executable = path.resolve('scripts/nix-app/tower-worker-permission-preflight');
    try {
      return JSON.parse(execFileSync(executable, ['plan', '--user', user, '--backend-user', backendUser, '--root', root, '--max-entries', '50000', '--timeout', '120'], { encoding: 'utf8', timeout: 130_000 })) as PreflightReport;
    } catch (error) {
      const stdout = (error as { stdout?: string | Buffer }).stdout?.toString();
      if (!stdout) throw error;
      return JSON.parse(stdout) as PreflightReport;
    }
  },
  readAcl(target, kind) {
    const args = kind === 'default' ? ['-cpdn', '--', target] : ['-cpn', '--', target];
    return execFileSync('/usr/bin/getfacl', args, { encoding: 'utf8', timeout: 5000 }).trim();
  },
  stat: target => fs.lstatSync(target),
  applyAcl(target, policy) {
    const stat = fs.lstatSync(target.path);
    const entries = migrationProjectPeerAcl(policy.backendUid, policy.workerUid, stat.isDirectory(), !!(stat.mode & 0o111));
    execFileSync(resolveNewProjectAclExecutable(), ['-m', entries.join(','), '--', target.path], { stdio: 'pipe', timeout: 5000 });
  },
  restoreAcl: snapshot => { execFileSync(resolveNewProjectAclExecutable(), ['--restore', snapshot], { stdio: 'pipe', timeout: 30_000 }); },
  async verifyWorkerAccess(project, deploymentId) {
    const probe = `.tower-migration-worker-${randomUUID()}`;
    const sessionId = randomUUID();
    // Keep the peer-created inode until the backend has actually modified it.
    const command = `umask 077; printf worker > ${JSON.stringify(probe)}; test "$(cat ${JSON.stringify(probe)})" = worker`;
    const request = {
      command,
      cwd: '/workspace',
      lifecycle: 'foreground' as const,
      timeoutSec: 10,
    };
    const executionContext = {
      projectId: project.id,
      deploymentId,
      actorUserId: project.owner_user_id,
      sessionId,
      userRole: 'admin' as const,
      projectWritable: true,
      projectRoot: project.root_path,
      logicalRoot: '/workspace' as const,
      environmentMode: 'canonical-project-workspace' as const,
      requiredCapabilities: ['job'],
    };
    const provider = await selectProjectExecutionProvider({
      projectId: project.id,
      actorUserId: project.owner_user_id,
      sessionId: executionContext.sessionId,
      projectRoot: project.root_path,
      deploymentId,
      executionContext,
      request,
      runtimeBoxCompatibilityEnabled: false,
    });
    if (provider.kind !== 'remote-worker') throw new Error('CANONICAL_PROJECT_MIGRATION_WORKER_REQUIRED');
    const result = await executeWorkbenchRequest({
      request,
      context: { projectId: project.id, userId: project.owner_user_id, sessionId: executionContext.sessionId, userRole: 'admin', projectMember: true, projectWritable: true, projectOwner: true },
      provider,
    });
    if (result.execution.lifecycle !== 'foreground' || !result.execution.outcome.ok) throw new Error('CANONICAL_PROJECT_MIGRATION_WORKER_SMOKE_FAILED');
    const hostProbe = path.join(project.root_path, probe);
    try {
      const file = fs.openSync(hostProbe, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      try {
        const metadata = fs.fstatSync(file);
        if (!metadata.isFile() || metadata.nlink !== 1) fail('WORKER_PROBE_UNSAFE');
        if (fs.readFileSync(file, 'utf8') !== 'worker') fail('WORKER_PROBE_CONTENT_MISMATCH');
        fs.ftruncateSync(file, 0);
        fs.writeSync(file, 'backend', 0, 'utf8');
        fs.fsyncSync(file);
      } finally { fs.closeSync(file); }
      const check = { ...request, command: `test "$(cat ${JSON.stringify(probe)})" = backend` };
      const peerResult = await executeWorkbenchRequest({
        request: check,
        context: { projectId: project.id, userId: project.owner_user_id, sessionId: executionContext.sessionId, userRole: 'admin', projectMember: true, projectWritable: true, projectOwner: true },
        provider,
      });
      if (peerResult.execution.lifecycle !== 'foreground' || !peerResult.execution.outcome.ok) fail('WORKER_BACKEND_ROUNDTRIP_FAILED');
    } finally { fs.unlinkSync(hostProbe); }

  },
  verifyBackendAccess(root, backendUid) {
    if (process.getuid?.() !== backendUid) fail('BACKEND_IDENTITY_MISMATCH');
    const probe = path.join(root, `.tower-migration-backend-${randomUUID()}`);
    fs.writeFileSync(probe, 'backend', { flag: 'wx' });
    if (fs.readFileSync(probe, 'utf8') !== 'backend') fail('BACKEND_SMOKE_FAILED');
    fs.rmSync(probe);
  },
  async persistHostBinding(projectId, deploymentId) {
    await transaction(async client => {
      const db = withClient(client);
      const inserted = await db.queryOne<{ project_id: string }>(
        `INSERT INTO project_file_storage_bindings(project_id,deployment_id,storage_kind,worker_id,state,version)
         VALUES($1,$2,'host',NULL,'ready',1) ON CONFLICT(project_id,deployment_id) DO NOTHING RETURNING project_id`, [projectId, deploymentId]);
      if (!inserted) {
        const current = await db.queryOne<{ storage_kind: string; worker_id: string | null; state: string }>(
          'SELECT storage_kind,worker_id,state FROM project_file_storage_bindings WHERE project_id=$1 AND deployment_id=$2 FOR UPDATE', [projectId, deploymentId]);
        if (!current || current.storage_kind !== 'host' || current.worker_id !== null || current.state !== 'ready') fail('STORAGE_CONFLICT');
      }
    });
  },
  now: () => new Date(),
};
