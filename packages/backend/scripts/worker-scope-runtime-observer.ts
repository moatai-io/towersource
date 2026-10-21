import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { queryOne } from '../db/pg-repo.js';
import { verifyWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';
import { digest, protectedPath, type AssignmentInput, type AssignmentOperation, type LiveEvidence, type ScopeLifecycleAdapters } from './worker-scope-assignment-lifecycle.js';

/** Read-only system profile. Shares the existing maintenance HTTP status + SQL
 * reservation/service predicates and exact UID/cgroup idle semantics. The old
 * observer CLI rejects stale rows outright, so its output cannot distinguish an
 * expected revoked-token transition from DB outage. This module uses a read-only
 * SELECT with the same counts, adding identity linkage and scope (no CLI fork,
 * no DB writes, no copied credentials). Unknown observation always throws.
 */
export interface ScopeRuntimePolicy {
  version: 1; workerId: string; deploymentId: string; executionUid: number; executionGid: number;
  workerUnit: string; heartbeatUnit: string; workerFragment: string; heartbeatFragment: string;
  baseUrl: string; controlPlaneUrl: string; storePath: string; sourceRev: string;
  configFile: string; identityFile: string; stateFile: string; lockFile: string; backupDirectory: string;
  projectsRoot: string; coordinatorUnit: string; coordinatorFragment: string;
}
export interface DbRuntimeEvidence {
  worker_id: string; deployment_id: string; base_url: string; project_ids: string[];
  draining: boolean; reservations: number; services: number; heartbeat_at: number; observed_at: number;
  active: Array<{ jti: string; project_ids: string[]; capabilities: string[] }>;
  identities: Array<{ jti: string; revoked_at: string | null; replaced_by_jti: string | null; project_ids: string[] }>;
}
export interface ProcessEvidence {
  pid: number; uid: number; gid: number; startedAt: number; startTicks: string;
  argv: string[]; environment: Record<string, string>; cgroup: string;
}
const readOnlyEnvKeys = new Set(['TOWER_WORKER_MAINTENANCE_STATE','TOWER_REMOTE_WORKER_CONFIG','TOWER_LOCAL_WORKER_ID','TOWER_LOCAL_WORKER_DEPLOYMENT_ID','TOWER_LOCAL_WORKER_IDENTITY_FILE','TOWER_LOCAL_WORKER_PROJECT_IDS','TOWER_LOCAL_WORKER_BASE_URL']);
const exec = promisify(execFile);
async function command(file: string, args: string[]): Promise<string> {
  try { return (await exec(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout; }
  catch { throw new Error('SCOPE_RUNTIME_COMMAND_UNAVAILABLE'); }
}
export async function readScopeProcess(pid: number): Promise<ProcessEvidence> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('SCOPE_RUNTIME_PID_INVALID');
  try {
    const dir = `/proc/${pid}`;
    const first = fs.readFileSync(`${dir}/stat`, 'utf8');
    const statFields = first.slice(first.lastIndexOf(')') + 2).split(' ');
    const startTicks = statFields[19]; // /proc stat field 22, after pid/comm
    const ticks = Number((await command('getconf', ['CLK_TCK'])).trim());
    const boot = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1]);
    if (!Number.isFinite(ticks) || ticks <= 0 || !Number.isFinite(boot) || !/^\d+$/.test(startTicks)) throw new Error('CLOCK');
    const status = fs.readFileSync(`${dir}/status`, 'utf8');
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]); const gid = Number(/^Gid:\s+(\d+)/m.exec(status)?.[1]);
    const argv = fs.readFileSync(`${dir}/cmdline`, 'utf8').split('\0').filter(Boolean);
    // Drop all non-allowlisted keys immediately, never return transport/DB secrets.
    const environment: Record<string, string> = {};
    for (const entry of fs.readFileSync(`${dir}/environ`, 'utf8').split('\0')) {
      const n = entry.indexOf('='); if (n > 0 && readOnlyEnvKeys.has(entry.slice(0, n))) environment[entry.slice(0, n)] = entry.slice(n + 1);
    }
    const cgroup = /^0::([^\n]+)$/m.exec(fs.readFileSync(`${dir}/cgroup`, 'utf8'))?.[1];
    if (!cgroup || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw new Error('PROCESS');
    const again = fs.readFileSync(`${dir}/stat`, 'utf8');
    if (again.slice(again.lastIndexOf(')') + 2).split(' ')[19] !== startTicks) throw new Error('PID_REUSED');
    return { pid, uid, gid, startTicks, startedAt: (boot + Number(startTicks) / ticks) * 1000, argv, environment, cgroup };
  } catch { throw new Error('SCOPE_RUNTIME_PROCESS_UNAVAILABLE'); }
}
export function scopeLockHeld(file: string): boolean {
  try {
    const st = fs.statSync(file);
    for (const fd of fs.readdirSync('/proc/self/fdinfo')) {
      try {
        const open = fs.statSync(`/proc/self/fd/${fd}`);
        if (open.ino !== st.ino || open.dev !== st.dev) continue;
        if (/^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+/m.test(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))) return true;
      } catch { /* an unrelated fd may close during enumeration */ }
    }
    return false;
  } catch { return false; }
}
export function scopeUidProcesses(uid: number): number[] {
  const pids: number[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try { if (fs.statSync(`/proc/${entry}`).uid === uid) pids.push(Number(entry)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('SCOPE_RUNTIME_UID_SCAN_UNKNOWN'); }
  }
  return pids;
}
export function scopeCgroupProcesses(group: string, root = '/sys/fs/cgroup'): number[] {
  if (!group.startsWith('/') || group.includes('..') || group === '/') throw new Error('SCOPE_RUNTIME_CGROUP_INVALID');
  const start = path.join(root, group); const found = new Set<number>();
  function walk(dir: string) {
    const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('SCOPE_RUNTIME_CGROUP_INVALID');
    for (const value of fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8').trim().split(/\s+/).filter(Boolean)) {
      const pid = Number(value); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('SCOPE_RUNTIME_CGROUP_UNKNOWN'); found.add(pid);
    }
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('SCOPE_RUNTIME_CGROUP_INVALID');
      if (item.isDirectory()) walk(path.join(dir, item.name));
    }
  }
  try { walk(start); } catch { throw new Error('SCOPE_RUNTIME_CGROUP_UNKNOWN'); }
  return [...found];
}

export async function readScopeDbEvidence(workerId: string, deploymentId: string): Promise<DbRuntimeEvidence> {
  try {
    // Single SQL statement/snapshot. Expired-but-unreleased reservations count.
    const row = await queryOne<DbRuntimeEvidence>(`SELECT w.worker_id,w.metadata_json->>'deploymentId' AS deployment_id,w.base_url,w.project_ids,w.draining,
      EXTRACT(EPOCH FROM w.heartbeat_at)*1000 AS heartbeat_at, EXTRACT(EPOCH FROM NOW())*1000 AS observed_at,
      (SELECT count(*)::int FROM runtime_box_workbench_worker_capacity_reservations r WHERE r.worker_id=w.worker_id AND r.state='reserved') AS reservations,
      (SELECT count(*)::int FROM runtime_box_services s WHERE s.worker_id=w.worker_id AND s.status NOT IN ('stopped','failed','expired','error')) AS services,
      COALESCE((SELECT json_agg(json_build_object('jti',i.jti,'project_ids',i.project_ids,'capabilities',i.capabilities)) FROM runtime_box_workbench_worker_identities i
        WHERE i.worker_id=w.worker_id AND i.revoked_at IS NULL AND i.expires_at>NOW()),'[]'::json) AS active,
      COALESCE((SELECT json_agg(json_build_object('jti',i.jti,'project_ids',i.project_ids,'revoked_at',i.revoked_at,'replaced_by_jti',i.replaced_by_jti))
        FROM runtime_box_workbench_worker_identities i WHERE i.worker_id=w.worker_id AND (i.revoked_at IS NULL OR i.revoked_at>NOW()-INTERVAL '7 days')),'[]'::json) AS identities
      FROM runtime_box_workbench_workers w WHERE w.worker_id=$1 AND w.metadata_json->>'deploymentId'=$2`, [workerId, deploymentId]);
    if (!row) throw new Error('MISSING');
    return { ...row, heartbeat_at: Number(row.heartbeat_at), observed_at: Number(row.observed_at) };
  } catch { throw new Error('SCOPE_RUNTIME_DB_UNAVAILABLE'); }
}

interface ObservationPorts {
  uid(): number;
  process(pid: number): Promise<ProcessEvidence>;
  unit(name: string): Promise<Record<string, string>>;
  db(worker: string, deployment: string): Promise<DbRuntimeEvidence>;
  http(url: string, authenticated: boolean): Promise<any>;
  uidProcesses(uid: number): number[];
  cgroupProcesses(group: string): number[];
  lockHeld(file: string): boolean;
  project(value: AssignmentInput): Promise<boolean>;
}
function defaultPorts(token: () => Promise<string>): ObservationPorts {
  return {
    project: async value => {
      try {
        const row = await queryOne<{ root_path: string; allowed: boolean }>(`SELECT p.root_path,
          (COALESCE(p.archived,0)=0 AND COALESCE(p.lifecycle_status,'active')='active'
           AND NULLIF(BTRIM(COALESCE(p.system_key,'')),'') IS NULL
           AND d.desired_worker_id=$3 AND d.lease_owner=$4 AND d.status='preparing') AS allowed
          FROM projects p JOIN project_worker_assignment_desires d ON d.project_id=p.id AND d.deployment_id=$2
          WHERE p.id=$1`, [value.projectId,value.deploymentId,value.workerId,value.leaseOwner]);
        return row?.allowed === true && row.root_path === value.root;
      } catch { throw new Error('SCOPE_RUNTIME_PROJECT_AUTHORITY_UNAVAILABLE'); }
    },
    uid: () => process.getuid?.() ?? -1, process: readScopeProcess, db: readScopeDbEvidence,
    unit: async name => Object.fromEntries((await command('systemctl', ['show', name, '--property=MainPID,ControlGroup,User,Group,ActiveState,KillMode,SendSIGKILL,TimeoutStopUSec,FragmentPath,ProtectSystem,ProtectHome,ReadWritePaths,NoNewPrivileges'])).trim().split('\n').map(line => { const n = line.indexOf('='); return [line.slice(0, n), line.slice(n + 1)]; })),
    http: async (url, authenticated) => {
      try {
        const value = authenticated ? await token() : undefined; if (authenticated && !value) throw new Error('NO_TOKEN');
        const response = await fetch(url, { headers: value ? { authorization: `Bearer ${value}` } : {}, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('HTTP'); return await response.json();
      } catch { throw new Error('SCOPE_RUNTIME_HTTP_UNAVAILABLE'); }
    },
    uidProcesses: scopeUidProcesses, cgroupProcesses: scopeCgroupProcesses, lockHeld: scopeLockHeld,
  };
}
/** Trusted tests may replace explicit ports. No env switch, process/DB success
 * fallback or production mock is installed. Callbacks supply secret in memory only. */
export function createWorkerScopeRuntimeObserver(options: {
  policyFile: string; transportToken: () => Promise<string>; ports?: Partial<ObservationPorts>;
}): Pick<ScopeLifecycleAdapters, 'authorize' | 'idle' | 'observe'> {
  const io = { ...defaultPorts(options.transportToken), ...options.ports };
  let input: AssignmentInput | undefined; let policyBytes: string | undefined;
  function trusted(file: string, secret = false) {
    protectedPath(file); const st = fs.lstatSync(file);
    for (let p = path.dirname(file); ; p = path.dirname(p)) {
      if (fs.lstatSync(p).uid !== 0) throw new Error('SCOPE_RUNTIME_UNTRUSTED_PARENT');
      if (p === path.dirname(p)) break;
    }
    if (st.uid !== 0 || st.isSymbolicLink() || (secret && st.mode & 0o007)) throw new Error('SCOPE_RUNTIME_UNTRUSTED_INSTALLATION');
  }
  function policy(): ScopeRuntimePolicy {
    trusted(options.policyFile); const bytes = fs.readFileSync(options.policyFile, 'utf8');
    if (policyBytes !== undefined && policyBytes !== bytes) throw new Error('SCOPE_RUNTIME_POLICY_CHANGED');
    const c = JSON.parse(bytes) as ScopeRuntimePolicy;
    if (c.version !== 1 || !/^[A-Za-z0-9_-]+$/.test(c.workerId) || c.deploymentId === 'development'
      || !/^[A-Za-z0-9_-]+$/.test(c.deploymentId) || c.workerUnit !== `tower-workbench-worker-${c.workerId}.service`
      || c.heartbeatUnit !== `tower-workbench-worker-${c.workerId}-heartbeat.service`
      || !/^tower-[A-Za-z0-9_-]+\.service$/.test(c.coordinatorUnit)
      || !Number.isSafeInteger(c.executionUid) || c.executionUid <= 0 || !Number.isSafeInteger(c.executionGid) || c.executionGid <= 0
      || !/^\/nix\/store\/[a-z0-9]{32}-[^/\s]+$/.test(c.storePath) || !/^[a-f0-9]{40}$/.test(c.sourceRev)) throw new Error('SCOPE_RUNTIME_POLICY_INVALID');
    for (const url of [c.baseUrl, c.controlPlaneUrl]) if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url)) throw new Error('SCOPE_RUNTIME_NONLOCAL_ENDPOINT');
    for (const key of ['workerFragment','heartbeatFragment','coordinatorFragment','configFile','identityFile','stateFile','lockFile','backupDirectory','projectsRoot'] as const) {
      if (!/^\/[A-Za-z0-9_./-]+$/.test(c[key]) || path.resolve(c[key]) !== c[key]) throw new Error('SCOPE_RUNTIME_PATH_INVALID');
    }
    policyBytes = bytes; return c;
  }
  function state(c: ScopeRuntimePolicy) {
    trusted(c.stateFile); const s = JSON.parse(fs.readFileSync(c.stateFile, 'utf8'));
    if (s.version !== 1 || !(s.owner === null || typeof s.owner === 'string' && s.owner.length > 0)) throw new Error('SCOPE_RUNTIME_STATE_INVALID');
    if (s.owner && (s.operation?.id !== s.owner || s.operation?.kind !== 'scope-assignment'
      || s.operation.workerId !== c.workerId || s.operation.deploymentId !== c.deploymentId)) throw new Error('SCOPE_RUNTIME_FOREIGN_OWNER');
    return s as { owner: string | null; operation?: AssignmentOperation };
  }
  async function installation(c: ScopeRuntimePolicy) {
    if (!input || io.uid() !== 0) throw new Error('SCOPE_RUNTIME_NOT_AUTHORIZED');
    for (const p of [c.configFile,c.identityFile,c.stateFile,c.lockFile,c.backupDirectory,c.workerFragment,c.heartbeatFragment,c.coordinatorFragment]) trusted(p, p === c.identityFile);
    const config = JSON.parse(fs.readFileSync(c.configFile, 'utf8'));
    if (config.workerId !== c.workerId || config.host !== '127.0.0.1' || `http://127.0.0.1:${config.port}` !== c.baseUrl) throw new Error('SCOPE_RUNTIME_CONFIG_MISMATCH');
    const identity = fs.statSync(c.identityFile);
    if (identity.gid !== c.executionGid || (identity.mode & 0o777) !== 0o640) throw new Error('SCOPE_RUNTIME_IDENTITY_POLICY_MISMATCH');
    const manifest = JSON.parse(fs.readFileSync(path.join(c.storePath, 'share/tower/release-manifest.json'), 'utf8'));
    if (manifest.sourceRev !== c.sourceRev) throw new Error('SCOPE_RUNTIME_MANIFEST_MISMATCH');
    const backend = await io.http(`${c.controlPlaneUrl}/api/health`, false);
    if (backend.status !== 'ok' || backend.sourceRev !== c.sourceRev) throw new Error('SCOPE_RUNTIME_BACKEND_CHANGED');
    const coordinator = await io.unit(c.coordinatorUnit);
    if (coordinator.User !== 'root' || coordinator.FragmentPath !== c.coordinatorFragment || coordinator.ActiveState !== 'active'
      || coordinator.ProtectSystem !== 'strict' || coordinator.ProtectHome !== 'read-only' || coordinator.NoNewPrivileges !== 'yes') throw new Error('SCOPE_RUNTIME_COORDINATOR_POLICY_MISMATCH');
    const self = await io.process(process.pid);
    if (self.uid !== 0 || self.cgroup !== coordinator.ControlGroup) throw new Error('SCOPE_RUNTIME_COORDINATOR_PROCESS_MISMATCH');
    const writable = (coordinator.ReadWritePaths || '').split(' ').filter(Boolean);
    const allowed = [...new Set([path.dirname(c.configFile),path.dirname(c.identityFile),path.dirname(c.stateFile),c.backupDirectory,path.dirname(c.heartbeatFragment)])];
    if (writable.length !== allowed.length || writable.some(p => !allowed.includes(p))) throw new Error('SCOPE_RUNTIME_WRITABLE_PATHS_MISMATCH');
  }
  async function sample(c: ScopeRuntimePolicy) {
    await installation(c); const journal = state(c);
    const [unit, heartbeat, db, status] = await Promise.all([io.unit(c.workerUnit), io.unit(c.heartbeatUnit), io.db(c.workerId,c.deploymentId), io.http(`${c.baseUrl}/v1/maintenance/status`, true)]);
    if (unit.ActiveState !== 'active' || heartbeat.ActiveState !== 'active' || unit.FragmentPath !== c.workerFragment || heartbeat.FragmentPath !== c.heartbeatFragment
      || unit.KillMode !== 'process' || unit.SendSIGKILL !== 'no' || unit.TimeoutStopUSec !== 'infinity') throw new Error('SCOPE_RUNTIME_UNIT_UNSAFE');
    const worker = await io.process(Number(unit.MainPID)); const beat = await io.process(Number(heartbeat.MainPID));
    for (const proc of [worker, beat]) if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0 || !/^\d+$/.test(proc.startTicks) || proc.uid !== c.executionUid || proc.gid !== c.executionGid || !Number.isFinite(proc.startedAt) || proc.startedAt <= 0 || proc.startedAt > Date.now()+2000) throw new Error('SCOPE_RUNTIME_EXECUTION_USER_MISMATCH');
    if (worker.cgroup !== unit.ControlGroup || beat.cgroup !== heartbeat.ControlGroup || worker.pid === beat.pid
      || !worker.argv.includes(`${c.storePath}/lib/tower/dist/backend/packages/backend/services/runtime-box/remote-workbench-worker-entrypoint.js`)
      || !beat.argv.includes(`${c.storePath}/lib/tower/dist/backend/packages/backend/scripts/local-workbench-worker-heartbeat.js`)
      || worker.environment.TOWER_WORKER_MAINTENANCE_STATE !== c.stateFile || worker.environment.TOWER_REMOTE_WORKER_CONFIG !== c.configFile
      || beat.environment.TOWER_LOCAL_WORKER_ID !== c.workerId || beat.environment.TOWER_LOCAL_WORKER_DEPLOYMENT_ID !== c.deploymentId
      || beat.environment.TOWER_LOCAL_WORKER_IDENTITY_FILE !== c.identityFile || beat.environment.TOWER_LOCAL_WORKER_BASE_URL !== c.baseUrl) throw new Error('SCOPE_RUNTIME_LOADED_PROCESS_MISMATCH');
    if (status.version !== 1 || status.workerId !== c.workerId || status.pid !== worker.pid || status.storePath !== c.storePath
      || status.draining !== Boolean(journal.owner) || !Number.isSafeInteger(status.activeRequests) || status.activeRequests < 0) throw new Error('SCOPE_RUNTIME_HTTP_PROCESS_MISMATCH');
    if (db.worker_id !== c.workerId || db.deployment_id !== c.deploymentId || db.base_url !== c.baseUrl || typeof db.draining !== 'boolean'
      || ![db.reservations,db.services].every(n => Number.isSafeInteger(n) && n >= 0)
      || !Number.isFinite(db.heartbeat_at) || db.heartbeat_at <= 0 || !Number.isFinite(db.observed_at) || Math.abs(db.observed_at-Date.now())>5000
      || db.heartbeat_at > db.observed_at+2000 || db.active.length !== 1) throw new Error('SCOPE_RUNTIME_DB_EVIDENCE_INVALID');
    const nowWorker = await io.process(worker.pid); const nowBeat = await io.process(beat.pid);
    const again = await io.unit(c.workerUnit); const againBeat = await io.unit(c.heartbeatUnit);
    if (worker.startTicks !== nowWorker.startTicks || beat.startTicks !== nowBeat.startTicks || again.MainPID !== unit.MainPID || againBeat.MainPID !== heartbeat.MainPID) throw new Error('SCOPE_RUNTIME_PROCESS_CHANGED');
    const ids = (beat.environment.TOWER_LOCAL_WORKER_PROJECT_IDS || '').split(',');
    if (!ids.length || ids.some(id => !/^[A-Za-z0-9_-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('SCOPE_RUNTIME_LOADED_SCOPE_INVALID');
    if (state(c).owner !== journal.owner) throw new Error('SCOPE_RUNTIME_OWNER_CHANGED');
    return { journal, worker, beat, db, status, ids };
  }
  async function idle(owner: string, context?: Parameters<ScopeLifecycleAdapters['idle']>[1]) {
    const c = policy(); if (!io.lockHeld(c.lockFile)) throw new Error('SCOPE_RUNTIME_EX_LOCK_REQUIRED');
    const s = await sample(c); const op = s.journal.operation;
    if (owner !== s.journal.owner || !op || op.id !== owner) throw new Error('SCOPE_RUNTIME_OWNER_REQUIRED');
    const fresh = s.db.heartbeat_at > 0 && s.db.observed_at - s.db.heartbeat_at <= 15000;
    const exact = (a: string[], b: string[]) => [...a].sort().join('\0') === [...b].sort().join('\0');
    if (context?.mode === 'owned-transition') {
      if (context.oldJti !== op.oldJti || context.newJti !== op.newJti || context.rollbackJti !== op.rollbackJti) throw new Error('SCOPE_RUNTIME_TRANSITION_CONTEXT_MISMATCH');
      const active = s.db.active[0]; const chain = [op.oldJti,op.newJti,op.rollbackJti].filter(Boolean) as string[];
      const index = chain.indexOf(active.jti);
      const activeScope = index === 1 ? op.newScope : op.oldScope;
      if (!exact(active.project_ids,Object.keys(activeScope))) throw new Error('SCOPE_RUNTIME_TRANSITION_SCOPE_UNKNOWN');
      if (index < 0 || (index > 0 && !s.db.identities.some(i => i.jti === chain[index-1] && i.revoked_at && i.replaced_by_jti === active.jti))) throw new Error('SCOPE_RUNTIME_TRANSITION_IDENTITY_UNKNOWN');
      const expectedScopes = [Object.keys(op.oldScope),Object.keys(op.newScope)];
      if (!expectedScopes.some(ids => exact(ids,s.ids)) || !expectedScopes.some(ids => exact(ids,s.db.project_ids))) throw new Error('SCOPE_RUNTIME_TRANSITION_SCOPE_UNKNOWN');
      // Stale is accepted ONLY for a proven replacement lineage during this owned
      // operation, not for DB failure or stale original identity before rotation.
      if (!fresh && (index === 0 || !['rotation-intent','identity-file-intent','config-intent','restart-intent','rollback-stage-intent','rollback-rotation-intent','rollback-files-intent','rollback-restart-intent'].includes(op.phase))) throw new Error('SCOPE_RUNTIME_HEARTBEAT_STALE');
      if (!fresh) {
        const predecessor = s.db.identities.find(i => i.jti === chain[index-1]);
        const revokedAt = Date.parse(predecessor?.revoked_at ?? '');
        // A new heartbeat process launched AFTER revocation cannot be excused as
        // the old process still holding its originally-read token. Unknown time
        // is also not an expected rotation window.
        if (!Number.isFinite(revokedAt) || s.beat.startedAt >= revokedAt) throw new Error('SCOPE_RUNTIME_STALE_PROCESS_UNPROVEN');
      }

    } else if (!fresh || s.db.active[0].jti !== op.oldJti || !exact(s.ids,s.db.project_ids)) throw new Error('SCOPE_RUNTIME_ADMISSION_STALE');
    if (s.status.activeRequests || s.db.draining || s.db.reservations || s.db.services) return false;
    const allowed = new Set([s.worker.pid,s.beat.pid]);
    if (io.uidProcesses(c.executionUid).some(pid => !allowed.has(pid))) return false;
    const workers = io.cgroupProcesses(s.worker.cgroup); const beats = io.cgroupProcesses(s.beat.cgroup);
    if (workers.length !== 1 || workers[0] !== s.worker.pid || beats.length !== 1 || beats[0] !== s.beat.pid) return false;
    if (!io.lockHeld(c.lockFile) || state(c).owner !== owner) throw new Error('SCOPE_RUNTIME_EXCLUSION_LOST');
    return true;
  }
  return {
    async authorize(value) {
      const c = policy();
      for (const key of ['workerId','deploymentId','configFile','identityFile','stateFile','lockFile','backupDirectory'] as const) if (value[key] !== c[key]) throw new Error('SCOPE_RUNTIME_INPUT_MISMATCH');
      if (!value.root.startsWith(c.projectsRoot + '/') || fs.realpathSync(value.root) !== value.root || !fs.statSync(value.root).isDirectory()) throw new Error('SCOPE_RUNTIME_PROJECT_ROOT_INVALID');
      const journal = state(c);
      if (!journal.owner && !(await io.project(value))) {
        // Terminal replay must be validated by DB adapter before release/result;
        // only the exact completed owner/lease may enter read-only recovery.
        const completed = JSON.parse(fs.readFileSync(c.stateFile,'utf8')).completedOperation;
        if (!completed || completed.projectId !== value.projectId || completed.leaseOwner !== value.leaseOwner
          || completed.workerId !== value.workerId || completed.deploymentId !== value.deploymentId) throw new Error('SCOPE_RUNTIME_PROJECT_NOT_AUTHORIZED');
      } else if (journal.owner && (journal.operation?.projectId !== value.projectId || journal.operation?.leaseOwner !== value.leaseOwner || journal.operation?.newScope?.[value.projectId] !== value.root)) throw new Error('SCOPE_RUNTIME_PROJECT_NOT_AUTHORIZED');
      input = { ...value }; await installation(c);
    },
    idle,
    async observe(): Promise<LiveEvidence> {
      const c = policy(); const s = await sample(c);
      const configBytes = fs.readFileSync(c.configFile,'utf8'); const config = JSON.parse(configBytes);
      const identity = verifyWorkbenchWorkerIdentity(fs.readFileSync(c.identityFile,'utf8').trim());
      // /proc does not reveal the JWT already read into heartbeat memory. Never
      // pretend current disk JWT is loaded after rotation. We can bind it only
      // when the protected file predates the heartbeat process AND a fresh DB
      // heartbeat after that process start confirms the sole active identity.
      const identityLoaded = identity && identity.workerId === c.workerId && identity.jti === s.db.active[0].jti
        && fs.statSync(c.identityFile).mtimeMs < s.beat.startedAt && s.db.heartbeat_at >= s.beat.startedAt
        && s.db.observed_at-s.db.heartbeat_at<=15000
        && [...identity.projectIds].sort().join('\0') === [...s.ids].sort().join('\0')
        && [...s.ids].sort().join('\0') === [...s.db.project_ids].sort().join('\0');
      let scope = config.projects;
      if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.values(scope).some(v => typeof v !== 'string' || !path.isAbsolute(v))) throw new Error('SCOPE_RUNTIME_SCOPE_INVALID');
      if (fs.statSync(c.configFile).mtimeMs >= s.worker.startedAt) {
        const op = s.journal.operation;
        if (!op || s.worker.pid !== op.oldPid || ![op.config.sha256,op.newConfigSha256].includes(digest(configBytes))) throw new Error('SCOPE_RUNTIME_LOADED_CONFIG_UNKNOWN');
        scope = op.oldScope; // journal's original loaded PID, never infer new scope
      }
      return { pid: s.worker.pid, heartbeatPid: s.beat.pid, heartbeatStartedAt: s.beat.startedAt,
        heartbeatIdentityJti: identityLoaded ? identity.jti : '', identityJti: identityLoaded ? identity.jti : '',
        storePath: c.storePath, scope, heartbeatAt: s.db.heartbeat_at, fenceOwner: s.journal.owner ?? '', activeRequests: s.status.activeRequests };
    },
  };
}
