import type { HeartbeatScopeEvidence } from './worker-scope-heartbeat-adapter.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** Not installed/wired. Existing-path scope changes under maintenance's durable
 * owner + EX lock. All provider actions are explicit adapters; no installer,
 * arbitrary shell, privilege escalation, DB connection or systemctl in this module.
 * File and DB commits are deliberately NOT described as one atomic transaction.
 */
export type Scope = Record<string, string>;
export interface FileEvidence { path: string; backup: string; sha256: string; uid: number; gid: number; mode: number }
export interface IdentityLink { activeJti: string; previousJti: string | null; projectIds: string[] }
export interface LiveEvidence {
  pid: number; storePath: string; scope: Scope; identityJti: string;
  heartbeatPid: number; heartbeatStartedAt: number; heartbeatIdentityJti: string;
  heartbeatAt: number; fenceOwner: string; activeRequests: number;
}
export interface ProbeReceipt { owner: string; projectId: string; rootDigest: string; pid: number; scopeDigest: string; cleaned: true }
export interface ProjectExecutionReceipt {
  owner: string; projectId: string; rootDigest: string; pid: number; scopeDigest: string;
  commandVerified: true; backendSharedWriteVerified: true; cleaned: true;
  nonce: string; operationDigest: string; rootIdentity: {dev:number;ino:number};
  backend: {pid:number;uid:number;gid:number;startTicks:string}; commandUid:number;
}
export interface AssignmentOperation {
  kind: 'scope-assignment'; version: 1; id: string; projectId: string; workerId: string; deploymentId: string; leaseOwner: string;
  phase: string; oldScope: Scope; newScope: Scope; oldJti: string; newJti?: string; rollbackJti?: string;
  rootIdentity: { dev: number; ino: number }; terminalIntent?: 'deferred' | 'rolled-back'; terminalVerification?: { jti: string; pid: number };
  oldPid: number; storePath: string; newConfigSha256: string; heartbeat?: HeartbeatScopeEvidence; config: FileEvidence; identity: FileEvidence;
  switchStartedAt?: number; rollbackStartedAt?: number; livePid?: number; executionNonce?: string; probe?: ProbeReceipt; executionReceipt?: ProjectExecutionReceipt;
}
interface State { version: 1; owner: string | null; phase: string; operation?: AssignmentOperation; [key: string]: unknown }
export interface AssignmentInput {
  workerId: string; deploymentId: string; projectId: string; root: string; leaseOwner: string;
  configFile: string; identityFile: string; stateFile: string; lockFile: string; backupDirectory: string;
}
export interface ScopeLifecycleAdapters {
  /** Existing authority only; validate enrollment/unit writable dirs and exact
   * installed paths/Worker ownership. No implicit root grant or chmod repair. */
  authorize(input: AssignmentInput): Promise<void>;
  /** Must confirm exact lease and no binding, without stealing expired leases. */
  assertLease(input: AssignmentInput): Promise<void>;
  readIdentity(): Promise<IdentityLink>;
  observe(): Promise<LiveEvidence>;
  /** Reuse maintenance idle: HTTP, DB reserved incl expired, services, UID,
   * cgroup, stable Worker/heartbeat PID and non-killing stop policy. */
  idle(owner: string, context?: { mode: 'admission' | 'owned-transition'; oldJti: string; newJti?: string; rollbackJti?: string }): Promise<boolean>;
  /** Issue JWT and persist it only in a protected temporary file BEFORE returning
   * JTI. Must not mutate identity DB yet. No raw token crosses this interface. */
  stageIdentity(scope: Scope, operationId: string, purpose: 'forward' | 'rollback'): Promise<{ jti: string }>;
  /** Official rotateWorkbenchWorkerIdentity; verify old/new scopes, sole active
   * identity, exact previous JTI and replacement linkage. May commit then throw. */
  rotateIdentity(previousJti: string, newJti: string): Promise<void>;
  /** Write staged token to existing identityFile by protected atomic rename,
   * keeping original uid/gid/mode. Never restore a revoked backup token. */
  publishIdentity(jti: string, target: FileEvidence): Promise<void>;
  /** Exact selected Worker + heartbeat, same immutable executable. Reads scope
   * from config or a narrow scope-only heartbeat update. Never full installer. */
  captureHeartbeatEvidence(scope: Scope, owner: string): Promise<HeartbeatScopeEvidence>;
  verifyHeartbeat(scope: Scope): Promise<void>;
  preflightHeartbeatRestore(): Promise<void>;
  restart(scope: Scope): Promise<void>;
  /** Fixed existing maintenance synthetic smoke; no arbitrary payload. */
  maintenanceSmoke(owner: string): Promise<void>;
  /** Read local token JTI without returning JWT and verify file uid/gid/mode. */
  publishedIdentity(): Promise<{ jti: string; uid: number; gid: number; mode: number }>;
  /** No command/path/project arguments: read Project/root/nonce from owned state.
   * Uses a fixed Worker-side probe, not existing general /v1/runs bypass. */
  projectProbe(owner: string): Promise<ProbeReceipt>;
  /** Required fixed exact-Project command + backend-identity shared write receipt.
   * No arbitrary command/path API; scratch-only maintenance smoke is insufficient. */
  projectExecutionProbe(owner: string): Promise<ProjectExecutionReceipt>;
  /** Read-only committed receipt + cleanup verification. Never rerun a nonce. */
  verifyCommittedProbe(operation: AssignmentOperation): Promise<void>;
  /** Read back exact binding, desire, lease and verification evidence.
   * 'absent' must prove no conflicting binding, not merely desire != active. */
  bindingState(operation: AssignmentOperation): Promise<'absent' | 'committed' | 'ambiguous' | 'deferred' | 'rolled-back'>;
  /** Commit exact binding-last + desire completion atomically where supported.
   * A thrown result is ALWAYS ambiguous until bindingState positively resolves. */
  commitBinding(operation: AssignmentOperation): Promise<void>;
  /** Exact desire failure/defer transition; never reset unrelated failed/recovery rows. */
  finishWithoutBinding(operation: AssignmentOperation, result: 'deferred' | 'rolled-back'): Promise<void>;
  /** Fault seam called only AFTER durable intent/result. Tests can terminate the
   * child here. Production omits it; it conveys no authorization. */
  checkpoint?(phase: string): Promise<void>;
}

export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
/** Stable execution proof binding; intentionally excludes phase and receipts. */
export function executionBindingDigest(op: AssignmentOperation): string {
  return digest(JSON.stringify({id:op.id,workerId:op.workerId,deploymentId:op.deploymentId,projectId:op.projectId,
    leaseOwner:op.leaseOwner,rootIdentity:op.rootIdentity,scopeDigest:scopeDigest(op.newScope),newJti:op.newJti,
    livePid:op.livePid,nonce:op.executionNonce,config:op.newConfigSha256}));
}
export function assertScopeExecutionBinding(op: AssignmentOperation, receipt: ProjectExecutionReceipt) {
  if (!op.executionNonce || receipt.nonce!==op.executionNonce || receipt.operationDigest!==executionBindingDigest(op)
    || receipt.rootIdentity?.dev!==op.rootIdentity.dev || receipt.rootIdentity?.ino!==op.rootIdentity.ino
    || ![receipt.backend?.pid,receipt.backend?.uid,receipt.backend?.gid].every(n=>Number.isSafeInteger(n)&&n>0)
    || !/^\d+$/.test(receipt.backend?.startTicks??'') || !Number.isSafeInteger(receipt.commandUid) || receipt.commandUid<0
    || receipt.backend.uid===receipt.commandUid || receipt.backend.pid===receipt.pid) throw new Error('SCOPE_PROJECT_EXECUTION_BINDING_REQUIRED');
}
export function scopeDigest(scope: Scope): string { return digest(JSON.stringify(Object.entries(scope).sort(([a], [b]) => a.localeCompare(b)))); }
function equal(a: Scope, b: Scope): boolean { return scopeDigest(a) === scopeDigest(b); }
function requireScope(scope: Scope): void {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !Object.keys(scope).length
    || Object.entries(scope).some(([id, root]) => !/^[a-zA-Z0-9_-]+$/.test(id) || typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root)) throw new Error('SCOPE_INVALID');
}

/** No symlinks or writable parents. Test fixtures use their current UID; authorize
 * must independently enforce installed root ownership for the system profile. */
export function protectedPath(file: string): void {
  const uid = process.getuid?.();
  let current = path.resolve(file);
  for (;;) {
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || ![0, uid].includes(st.uid) || (st.mode & 0o022)) throw new Error('SCOPE_UNTRUSTED_PATH');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function fileMetadata(file: string) {
  protectedPath(file); const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1) throw new Error('SCOPE_INPUT_NOT_REGULAR');
  return { uid: st.uid, gid: st.gid, mode: st.mode & 0o777 };
}
export function durableWrite(file: string, data: string | Buffer, meta = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mode: 0o600 }): void {
  protectedPath(path.dirname(file));
  const temp = path.join(path.dirname(file), `.scope-${randomUUID()}`);
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, data); fs.fchownSync(fd, meta.uid, meta.gid); fs.fchmodSync(fd, meta.mode); fs.fsyncSync(fd);
    fs.closeSync(fd); fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    // Keep a failed staged file private for explicit cleanup; never broad unlink.
    throw error;
  }
}
export function acquireScopeMutationLock(file: string): () => void {
  fileMetadata(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5000 });
  if (result.status !== 0) { fs.closeSync(fd); throw new Error(result.error || result.signal || result.status !== 1 ? 'SCOPE_LOCK_EXECUTION_FAILED' : 'SCOPE_DEPLOYMENT_LOCK_BUSY'); }
  return () => fs.closeSync(fd);
}
function backup(file: string, directory: string, name: string): FileEvidence {
  const meta = fileMetadata(file); const bytes = fs.readFileSync(file); const destination = path.join(directory, name);
  if (fs.existsSync(destination)) throw new Error('SCOPE_BACKUP_COLLISION');
  durableWrite(destination, bytes); // secret-bearing identity backups stay 0600
  return { path: file, backup: destination, sha256: digest(bytes), ...meta };
}
function assertBackup(file: FileEvidence): void {
  fileMetadata(file.backup);
  if (digest(fs.readFileSync(file.backup)) !== file.sha256) throw new Error('SCOPE_BACKUP_CHANGED');
}
function readState(file: string): State {
  fileMetadata(file); const state = JSON.parse(fs.readFileSync(file, 'utf8')) as State;
  if (state.version !== 1 || !(state.owner === null || typeof state.owner === 'string' && /^[a-zA-Z0-9-]{1,120}$/.test(state.owner))) throw new Error('SCOPE_INVALID_STATE');
  return state;
}
function writeState(file: string, state: State) {
  // State is Worker-readable: never serialize adapter-added token/content fields.
  const allow = (value: object, keys: string[]) => {
    if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('SCOPE_JOURNAL_UNKNOWN_FIELD');
  };
  allow(state, ['version','owner','phase','operation','completedOperation','completedOwner','result','updatedAt','nextAttempt','oldTarget','target','switchStartedAt','failedPhase']);
  for (const value of [state.operation, state.completedOperation]) {
    if (!value || typeof value !== 'object') continue;
    const op = value as AssignmentOperation;
    allow(op, ['kind','version','id','projectId','workerId','deploymentId','leaseOwner','phase','oldScope','newScope','oldJti','newJti','rollbackJti','rootIdentity','terminalIntent','terminalVerification','oldPid','storePath','newConfigSha256','heartbeat','config','identity','switchStartedAt','rollbackStartedAt','livePid','executionNonce','probe','executionReceipt']);
    for (const f of [op.config, op.identity]) allow(f, ['path','backup','sha256','uid','gid','mode']);
    allow(op.rootIdentity, ['dev','ino']);
    if (op.terminalVerification) allow(op.terminalVerification, ['jti','pid']);
    if (op.probe) allow(op.probe, ['owner','projectId','rootDigest','pid','scopeDigest','cleaned']);
    if (op.executionReceipt) allow(op.executionReceipt, ['owner','projectId','rootDigest','pid','scopeDigest','cleaned','commandVerified','backendSharedWriteVerified','nonce','operationDigest','rootIdentity','backend','commandUid']);
    if (op.executionReceipt) {
      allow(op.executionReceipt.rootIdentity,['dev','ino']);
      allow(op.executionReceipt.backend,['pid','uid','gid','startTicks']);
    }
    if (op.heartbeat) {
      allow(op.heartbeat, ['version','workerUnit','heartbeatUnit','fragment','oldLine','newLine','afterSha256','inventory']);
      if (op.heartbeat.fragment) allow(op.heartbeat.fragment, ['path','backup','sha256','uid','gid','mode']);
      for (const f of op.heartbeat.inventory ?? []) allow(f, ['path','sha256','uid','gid','mode']);
    }
  }
  durableWrite(file, JSON.stringify(state) + '\n', fileMetadata(file));
}
function identityMatches(value: IdentityLink, jti: string, previous: string | null, scope: Scope) {
  return value.activeJti === jti && value.previousJti === previous
    && [...value.projectIds].sort().join('\0') === Object.keys(scope).sort().join('\0');
}

export class WorkerScopeAssignmentLifecycle {
  constructor(private readonly input: AssignmentInput, private readonly adapter: ScopeLifecycleAdapters) {}
  private state!: State;
  private get op() { return this.state.operation!; }
  private assertRoot() {
    const root = fs.statSync(this.input.root);
    if (!root.isDirectory() || fs.realpathSync(this.input.root) !== this.input.root || root.dev !== this.op.rootIdentity.dev || root.ino !== this.op.rootIdentity.ino) throw new Error('SCOPE_PROJECT_ROOT_CHANGED');
  }
  private async finishTerminal(result: 'deferred' | 'rolled-back') {
    const live = await this.adapter.observe();
    await this.step('terminal-intent', { terminalIntent: result, terminalVerification: { jti: live.identityJti, pid: live.pid } });
    await this.adapter.finishWithoutBinding(this.op, result);
    await this.step('terminal-committed');
    await this.release(result);
  }
  private async verifyTerminal(result: 'deferred' | 'rolled-back') {
    const op = this.op;
    const identity = await this.adapter.readIdentity(); const live = await this.adapter.observe();
    const jti = result === 'deferred' ? op.oldJti : op.rollbackJti ?? op.oldJti;
    if (op.terminalIntent !== result || !op.terminalVerification || identity.activeJti !== jti
      || op.terminalVerification.jti !== jti || live.identityJti !== jti || live.pid !== op.terminalVerification.pid
      || !equal(live.scope, op.oldScope) || digest(fs.readFileSync(op.config.path)) !== op.config.sha256) throw new Error('SCOPE_TERMINAL_EVIDENCE_CHANGED');
    await this.verifyPublished(jti);
    if (op.heartbeat) await this.adapter.verifyHeartbeat(op.oldScope);
    if (result === 'deferred' && digest(fs.readFileSync(op.identity.path)) !== op.identity.sha256) throw new Error('SCOPE_TERMINAL_IDENTITY_CHANGED');
    if (result === 'rolled-back') { await this.assertIdle(); await this.adapter.maintenanceSmoke(op.id); }
  }
  private async step(phase: string, updates: Partial<AssignmentOperation> = {}) {
    this.assertRoot();
    const disk = readState(this.input.stateFile);
    if (disk.owner !== this.state.owner || disk.operation?.id !== this.op.id) throw new Error('SCOPE_OWNER_CHANGED');
    Object.assign(this.op, updates, { phase }); this.state.phase = phase;
    writeState(this.input.stateFile, this.state);
    await this.adapter.checkpoint?.(phase);
  }
  private async assertIdle() {
    const disk = readState(this.input.stateFile);
    if (!this.state.owner || disk.owner !== this.state.owner || disk.operation?.id !== this.op.id) throw new Error('SCOPE_OWNER_CHANGED');
    if (!await this.adapter.idle(this.state.owner, { mode: this.op.newJti ? 'owned-transition' : 'admission', oldJti: this.op.oldJti, newJti: this.op.newJti, rollbackJti: this.op.rollbackJti })) throw new Error('SCOPE_WORKER_BUSY');
  }
  private async verifyLive(scope: Scope, jti: string, since: number, previousPid: number) {
    const live = await this.adapter.observe();
    const now = Date.now();
    if (!Number.isSafeInteger(live.pid) || !Number.isSafeInteger(live.heartbeatPid) || live.heartbeatPid <= 0
      || !Number.isFinite(since) || !Number.isFinite(live.heartbeatAt) || live.heartbeatAt < now - 15000 || live.heartbeatAt > now + 2000
      || !Number.isFinite(live.heartbeatStartedAt) || live.heartbeatStartedAt <= since || live.heartbeatStartedAt > now + 2000
      || live.heartbeatIdentityJti !== jti || live.pid <= 0 || live.pid === previousPid || live.storePath !== this.op.storePath || !equal(live.scope, scope)
      || live.identityJti !== jti || live.heartbeatAt <= since || live.fenceOwner !== this.state.owner || live.activeRequests !== 0) throw new Error('SCOPE_LIVE_VERIFICATION_FAILED');
    await this.assertIdle();
    await this.adapter.verifyHeartbeat(scope);
    return live;
  }
  private assertExecutionReceipt(receipt: ProjectExecutionReceipt | undefined, pid: number) {
    if (!receipt || receipt.owner !== this.op.id || receipt.projectId !== this.op.projectId
      || receipt.rootDigest !== digest(this.input.root) || receipt.scopeDigest !== scopeDigest(this.op.newScope)
      || receipt.pid !== pid || receipt.commandVerified !== true || receipt.backendSharedWriteVerified !== true
      || receipt.cleaned !== true) throw new Error('SCOPE_PROJECT_EXECUTION_RECEIPT_REQUIRED');
    assertScopeExecutionBinding(this.op, receipt);
  }
  private async verifyPublished(jti: string) {
    const value = await this.adapter.publishedIdentity();
    if (value.jti !== jti || value.uid !== this.op.identity.uid || value.gid !== this.op.identity.gid || value.mode !== this.op.identity.mode) throw new Error('SCOPE_PUBLISHED_IDENTITY_MISMATCH');
  }
  private async release(result: string) {
    this.assertRoot();
    const disk = readState(this.input.stateFile);
    if (disk.owner !== this.state.owner || disk.operation?.id !== this.op.id) throw new Error('SCOPE_OWNER_CHANGED');
    const { operation, ...base } = this.state;
    this.state = { ...base, completedOperation: operation, completedOwner: this.state.owner, owner: null, phase: 'idle', result };
    writeState(this.input.stateFile, this.state);
    await this.adapter.checkpoint?.('owner-released');
  }

  /** Only used for scope-changing system profile. The normal unchanged path must
   * be routed BEFORE constructing this controller; no root/enrollment regression. */
  async assign(claim?: { acquire():Promise<boolean> }): Promise<'assigned' | 'deferred'> {
    await this.adapter.authorize(this.input);
    const unlock = acquireScopeMutationLock(this.input.lockFile);
    try {
      this.state = readState(this.input.stateFile);
      if (this.state.owner !== null || this.state.phase !== 'idle') throw new Error('SCOPE_RECOVERY_REQUIRED');
      if (!claim) await this.adapter.assertLease(this.input);
      const config = JSON.parse(fs.readFileSync(this.input.configFile, 'utf8'));
      const oldScope = config.projects as Scope; requireScope(oldScope);
      if (Object.hasOwn(oldScope, this.input.projectId)) throw new Error('SCOPE_NO_MUTATION_REQUIRED');
      const newScope = { ...oldScope, [this.input.projectId]: this.input.root }; requireScope(newScope);
      const before = await this.adapter.observe(); const identity = await this.adapter.readIdentity();
      if (!equal(before.scope, oldScope) || before.identityJti !== identity.activeJti || before.fenceOwner
        || identity.projectIds.sort().join('\0') !== Object.keys(oldScope).sort().join('\0')) throw new Error('SCOPE_PREFLIGHT_DRIFT');
      protectedPath(this.input.backupDirectory);
      const id = randomUUID(); const dir = path.join(this.input.backupDirectory, id); fs.mkdirSync(dir, { mode: 0o700 });
      const parent = fs.openSync(this.input.backupDirectory, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      const configEvidence = backup(this.input.configFile, dir, 'config.backup');
      const identityEvidence = backup(this.input.identityFile, dir, 'identity.backup');
      const rootStat = fs.statSync(this.input.root);
      if (!rootStat.isDirectory() || fs.realpathSync(this.input.root) !== this.input.root) throw new Error('SCOPE_PROJECT_ROOT_INVALID');
      const operation: AssignmentOperation = { kind: 'scope-assignment', version: 1, id, projectId: this.input.projectId,
        workerId: this.input.workerId, deploymentId: this.input.deploymentId, leaseOwner: this.input.leaseOwner,
        phase: claim ? 'claim-intent' : 'draining', rootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, oldScope, newScope, oldJti: identity.activeJti, oldPid: before.pid, storePath: before.storePath,
        newConfigSha256: digest(JSON.stringify({ ...config, projects: newScope }) + '\n'), config: configEvidence, identity: identityEvidence };
      this.state = { ...this.state, owner: id, phase: operation.phase, operation };
      writeState(this.input.stateFile, this.state); await this.adapter.checkpoint?.(operation.phase);
      // Durable fence, exact lease intent and backups precede even the claim RPC.
      // A failed/lost reply has a recoverable journal; no blind lease reset.
      if (claim) {
        if (!await claim.acquire()) throw new Error('SCOPE_CLAIM_NOT_ACQUIRED');
        await this.adapter.assertLease(this.input);
        await this.step('draining');
      }
      if (!await this.adapter.idle(id)) {
        await this.finishTerminal('deferred'); return 'deferred';
      }
      await this.step('heartbeat-plan-intent');
      const heartbeat = await this.adapter.captureHeartbeatEvidence(newScope, id);
      await this.step('heartbeat-planned', { heartbeat });
      await this.step('stage-intent');
      const staged = await this.adapter.stageIdentity(newScope, id, 'forward');
      await this.step('rotation-intent', { newJti: staged.jti });
      await this.assertIdle(); await this.adapter.assertLease(this.input);
      await this.adapter.rotateIdentity(operation.oldJti, staged.jti);
      if (!identityMatches(await this.adapter.readIdentity(), staged.jti, operation.oldJti, newScope)) throw new Error('SCOPE_ROTATION_LINKAGE_UNKNOWN');
      await this.step('identity-file-intent');
      await this.adapter.publishIdentity(staged.jti, identityEvidence);
      await this.verifyPublished(staged.jti);
      await this.step('config-intent');
      if (digest(fs.readFileSync(this.input.configFile)) !== configEvidence.sha256) throw new Error('SCOPE_CONFIG_CHANGED');
      durableWrite(this.input.configFile, JSON.stringify({ ...config, projects: newScope }) + '\n', configEvidence);
      await this.step('restart-intent', { switchStartedAt: Date.now() });
      await this.assertIdle(); await this.adapter.restart(newScope);
      const live = await this.verifyLive(newScope, staged.jti, this.op.switchStartedAt!, before.pid);
      await this.step('probe-intent', { livePid: live.pid, executionNonce: randomUUID() });
      await this.adapter.maintenanceSmoke(id);
      const probe = await this.adapter.projectProbe(id);
      if (probe.owner !== id || probe.projectId !== operation.projectId || probe.pid !== live.pid || probe.scopeDigest !== scopeDigest(newScope)
        || probe.rootDigest !== digest(this.input.root) || probe.cleaned !== true) throw new Error('SCOPE_PROJECT_PROBE_FAILED');
      const executionReceipt = await this.adapter.projectExecutionProbe(id);
      this.assertExecutionReceipt(executionReceipt, live.pid);
      await this.step('binding-intent', { probe, executionReceipt });
      await this.assertIdle(); await this.adapter.assertLease(this.input);
      await this.adapter.commitBinding(this.op);
      if (await this.adapter.bindingState(this.op) !== 'committed') throw new Error('SCOPE_BINDING_COMMIT_AMBIGUOUS');
      await this.step('binding-committed');
      await this.release('scope-assigned'); return 'assigned';
    } finally { unlock(); } // On ANY failure/crash, owner stays; no blind rollback.
  }

  /** Explicit recovery only. DB ambiguity never authorizes rollback or release.
   * Unexpected identities/partial rollback stay fenced for operator inspection. */
  async recover(resolveClaim?:()=>Promise<'owned'|'unclaimed'|'ambiguous'>): Promise<'committed' | 'rolled-back' | 'deferred'> {
    await this.adapter.authorize(this.input);
    const unlock = acquireScopeMutationLock(this.input.lockFile);
    try {
      this.state = readState(this.input.stateFile);
      if (this.state.owner === null && this.state.phase === 'idle') {
        const completed = this.state.completedOperation as AssignmentOperation | undefined;
        if (!completed || completed.id !== this.state.completedOwner || completed.leaseOwner !== this.input.leaseOwner
          || completed.workerId !== this.input.workerId || completed.projectId !== this.input.projectId || completed.deploymentId !== this.input.deploymentId
          || completed.config.path !== this.input.configFile || completed.identity.path !== this.input.identityFile) throw new Error('SCOPE_COMPLETION_RECEIPT_MISMATCH');
        const result = await this.adapter.bindingState(completed);
        if (result !== 'deferred' && result !== 'rolled-back') throw new Error('SCOPE_COMPLETION_READBACK_UNSUPPORTED');
        const expected = result === 'deferred' ? completed.oldJti : completed.rollbackJti ?? completed.oldJti;
        const identity = await this.adapter.readIdentity(); const live = await this.adapter.observe();
        const installed = await this.adapter.publishedIdentity(); const root = fs.statSync(this.input.root);
        if (root.dev !== completed.rootIdentity.dev || root.ino !== completed.rootIdentity.ino
          || identity.activeJti !== expected || installed.jti !== expected || live.identityJti !== expected
          || live.pid !== completed.terminalVerification?.pid || live.fenceOwner || !equal(live.scope, completed.oldScope)
          || digest(fs.readFileSync(this.input.configFile)) !== completed.config.sha256) throw new Error('SCOPE_COMPLETION_EVIDENCE_CHANGED');
        return result; // release already durable; do not mutate/rotate/restart again
      }
      const op = this.state.operation;
      if (!this.state.owner || !op || op.kind !== 'scope-assignment' || op.version !== 1
        || op.id !== this.state.owner || op.workerId !== this.input.workerId || op.deploymentId !== this.input.deploymentId
        || op.projectId !== this.input.projectId || op.leaseOwner !== this.input.leaseOwner
        || op.config.path !== this.input.configFile || op.identity.path !== this.input.identityFile) throw new Error('SCOPE_RECOVERY_JOURNAL_MISMATCH');
      this.assertRoot();
      requireScope(op.oldScope); requireScope(op.newScope); assertBackup(op.config); assertBackup(op.identity);
      if (op.newScope[op.projectId] !== this.input.root || Object.hasOwn(op.oldScope, op.projectId)
        || !equal(op.newScope, { ...op.oldScope, [op.projectId]: this.input.root })) throw new Error('SCOPE_RECOVERY_SCOPE_MISMATCH');
      for (const file of [op.config, op.identity]) {
        const meta = fileMetadata(file.path);
        if (meta.uid !== file.uid || meta.gid !== file.gid || meta.mode !== file.mode) throw new Error('SCOPE_RECOVERY_METADATA_DRIFT');
      }
      if (op.phase === 'claim-intent') {
        if (!resolveClaim) throw new Error('SCOPE_CLAIM_RECOVERY_REQUIRED');
        const claim = await resolveClaim();
        if (claim === 'ambiguous') throw new Error('SCOPE_CLAIM_AMBIGUOUS');
        // An unclaimed snapshot cannot prove a delayed claim RPC will never
        // start. Keep the intent/fence; never release based on absence alone.
        if (claim === 'unclaimed') throw new Error('SCOPE_CLAIM_NOT_ACQUIRED_REVIEW_REQUIRED');
        await this.adapter.assertLease(this.input); await this.step('draining');
      }
      const binding = await this.adapter.bindingState(op);
      if (binding === 'deferred' || binding === 'rolled-back') { await this.verifyTerminal(binding); await this.release(binding); return binding; }
      if (binding === 'ambiguous') throw new Error('SCOPE_BINDING_COMMIT_AMBIGUOUS');
      const identity = await this.adapter.readIdentity();
      const configHash = digest(fs.readFileSync(op.config.path));
      if (![op.config.sha256, op.newConfigSha256].includes(configHash)) throw new Error('SCOPE_RECOVERY_CONFIG_DRIFT');
      if (binding === 'committed') {
        if (!op.newJti || !op.probe || !op.switchStartedAt || !identityMatches(identity, op.newJti, op.oldJti, op.newScope)) throw new Error('SCOPE_COMMITTED_EVIDENCE_MISSING');
        if (configHash !== op.newConfigSha256) throw new Error('SCOPE_COMMITTED_CONFIG_DRIFT');
        await this.verifyPublished(op.newJti);
        const live = await this.verifyLive(op.newScope, op.newJti, op.switchStartedAt, op.oldPid);
        this.assertExecutionReceipt(op.executionReceipt, live.pid);
        await this.adapter.verifyCommittedProbe(op);
        if (live.pid !== op.probe.pid) throw new Error('SCOPE_COMMITTED_PID_CHANGED');

        await this.release('scope-assigned-recovered'); return 'committed';
      }
      if (op.terminalIntent) {
        await this.verifyTerminal(op.terminalIntent);
        await this.adapter.finishWithoutBinding(op, op.terminalIntent);
        await this.step('terminal-committed');
        await this.release(op.terminalIntent); return op.terminalIntent;
      }
      // A failed probe is not a running request. Its filesystem residue remains
      // the durable recovery condition; never release owner over unknown scratch.
      if(fs.readdirSync(this.input.root).some(n=>n.startsWith('.tower-scope-exec-')||n.startsWith('.tower-assignment-probe-')))throw new Error('SCOPE_PROBE_CLEANUP_REQUIRES_REVIEW');
      await this.assertIdle();
      if (op.heartbeat) await this.adapter.preflightHeartbeatRestore();
      // A crash during rollback is not replayed from its beginning. The intended
      // JTI remains journaled for inspection; never issue competing replacements.
      if (op.rollbackJti || op.phase.startsWith('rollback')) throw new Error('SCOPE_PARTIAL_ROLLBACK_REQUIRES_REVIEW');
      const unchangedIdentity = identity.activeJti === op.oldJti && identity.projectIds.slice().sort().join('\0') === Object.keys(op.oldScope).sort().join('\0');
      if (!unchangedIdentity && (!op.newJti || !identityMatches(identity, op.newJti, op.oldJti, op.newScope))) throw new Error('SCOPE_ROTATION_COMMIT_AMBIGUOUS');
      if (unchangedIdentity) {
        // No official rotation committed: do not restart or rotate unnecessarily.
        const live = await this.adapter.observe();
        if (!equal(live.scope, op.oldScope) || live.identityJti !== op.oldJti || live.pid !== op.oldPid
          || digest(fs.readFileSync(op.config.path)) !== op.config.sha256 || digest(fs.readFileSync(op.identity.path)) !== op.identity.sha256) throw new Error('SCOPE_UNEXPECTED_PARTIAL_FILES');
      } else {
        await this.step('rollback-stage-intent');
        const staged = await this.adapter.stageIdentity(op.oldScope, op.id, 'rollback');
        await this.step('rollback-rotation-intent', { rollbackJti: staged.jti });
        await this.assertIdle(); await this.adapter.rotateIdentity(identity.activeJti, staged.jti);
        if (!identityMatches(await this.adapter.readIdentity(), staged.jti, identity.activeJti, op.oldScope)) throw new Error('SCOPE_ROLLBACK_LINKAGE_UNKNOWN');
        const previous = await this.adapter.observe();
        await this.step('rollback-files-intent');
        await this.adapter.publishIdentity(staged.jti, op.identity);
        await this.verifyPublished(staged.jti);
        durableWrite(op.config.path, fs.readFileSync(op.config.backup), op.config);
        await this.step('rollback-restart-intent', { rollbackStartedAt: Date.now() });
        await this.assertIdle(); await this.adapter.restart(op.oldScope);
        await this.verifyLive(op.oldScope, staged.jti, this.op.rollbackStartedAt!, previous.pid);
      }
      if (op.heartbeat) await this.adapter.verifyHeartbeat(op.oldScope);
      await this.adapter.maintenanceSmoke(op.id);
      await this.assertIdle();
      await this.step('rollback-verified');
      await this.finishTerminal('rolled-back'); return 'rolled-back';
    } finally { unlock(); }
  }
}
