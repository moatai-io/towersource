import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest, durableWrite, protectedPath, scopeDigest, type AssignmentOperation, type FileEvidence, type Scope } from './worker-scope-assignment-lifecycle.js';

export interface HeartbeatScopeEvidence {
  version: 1; workerUnit: string; heartbeatUnit: string; fragment: FileEvidence;
  oldLine: string; newLine: string; afterSha256: string;
  inventory: Array<{ path: string; sha256: string; uid: number; gid: number; mode: number }>;
}
export interface HeartbeatControlConfig {
  workerId: string; deploymentId: string; workerUnit: string; heartbeatUnit: string;
  workerFragment: string; heartbeatFragment: string; identityFile: string;
  stateFile: string; backupDirectory: string; storePath?: string;
}
export type SystemctlRunner = (args: string[]) => Promise<string>;
const exec = promisify(execFile);
/** Never called in tests; mutations are reachable only through authorize + idle
 * guarded adapter methods. A timeout affects the client, not Worker KillMode. */
export const runScopeSystemctl: SystemctlRunner = async args => {
  try { return (await exec('systemctl', args, { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout; }
  catch { throw new Error('SCOPE_SYSTEMCTL_FAILED'); }
};
const ID = /^[A-Za-z0-9_-]+$/;
function metadata(file: string) {
  protectedPath(file); const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o7000) throw new Error('HEARTBEAT_UNSAFE_FILE');
  return { path: file, sha256: digest(fs.readFileSync(file)), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}
function replaceScopeLine(text: string, oldLine: string, newLine: string): string {
  return text.split('\n').map(line => line === oldLine ? newLine : line).join('\n');
}
function sameIds(line: string, scope: Scope) {
  const ids = line.split('=')[2]?.split(',') ?? [];
  return ids.every(id => ID.test(id)) && new Set(ids).size === ids.length
    && ids.sort().join('\0') === Object.keys(scope).sort().join('\0');
}
function properties(text: string) { return Object.fromEntries(text.trim().split('\n').map(line => { const n = line.indexOf('='); return [line.slice(0, n), line.slice(n + 1)]; })); }

/** Supported profile: existing installed root/system unit with exactly one simple
 * PROJECT_IDS Environment line in its [Service] section. No new drop-in, installer,
 * unit regeneration, privilege grant, enable/start timer, or broad directory write.
 * Exact executable-only Nix heartbeat overrides are supported when the final
 * resolved override matches policy.storePath; every override remains hash-guarded.
 * Unsupported quoting/specifiers/EnvironmentFile/manager environment inheritance
 * fail closed; guessing effective systemd environment is not safe.
 */
export function createWorkerScopeHeartbeatAdapter(options: {
  trustedConfigFile: string;
  authorize(config: HeartbeatControlConfig): Promise<void>;
  idle(owner: string, context?: { mode: 'admission' | 'owned-transition'; oldJti: string; newJti?: string; rollbackJti?: string }): Promise<boolean>;
  runner?: SystemctlRunner;
}) {
  const run = options.runner ?? runScopeSystemctl;
  function config(): HeartbeatControlConfig {
    metadata(options.trustedConfigFile);
    const c = JSON.parse(fs.readFileSync(options.trustedConfigFile, 'utf8')) as HeartbeatControlConfig;
    if (!ID.test(c.workerId) || !ID.test(c.deploymentId) || c.workerUnit !== `tower-workbench-worker-${c.workerId}.service`
      || c.heartbeatUnit !== `tower-workbench-worker-${c.workerId}-heartbeat.service`) throw new Error('HEARTBEAT_UNIT_ID_MISMATCH');
    for (const p of [c.workerFragment, c.heartbeatFragment, c.identityFile, c.stateFile, c.backupDirectory]) {
      if (typeof p !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(p) || path.resolve(p) !== p) throw new Error('HEARTBEAT_INVALID_PATH');
    }
    if (path.basename(c.workerFragment) !== c.workerUnit || path.basename(c.heartbeatFragment) !== c.heartbeatUnit) throw new Error('HEARTBEAT_FRAGMENT_MISMATCH');
    return c;
  }
  function operation(c: HeartbeatControlConfig): AssignmentOperation {
    metadata(c.stateFile); const state = JSON.parse(fs.readFileSync(c.stateFile, 'utf8'));
    const op = state.operation;
    if (state.version !== 1 || !state.owner || state.owner !== op?.id || op.kind !== 'scope-assignment' || op.version !== 1
      || op.workerId !== c.workerId || op.deploymentId !== c.deploymentId || op.identity.path !== c.identityFile) throw new Error('HEARTBEAT_OWNER_MISMATCH');
    return op;
  }
  async function guard(c: HeartbeatControlConfig) {
    await options.authorize(c); // Caller must validate existing root policy AND held EX lock.
    const op = operation(c);
    if (!await options.idle(op.id, { mode: op.newJti ? 'owned-transition' : 'admission', oldJti: op.oldJti, newJti: op.newJti, rollbackJti: op.rollbackJti })) throw new Error('HEARTBEAT_WORKER_BUSY');
    return op;
  }
  async function inventory(c: HeartbeatControlConfig, allowJournaledReload = false) {
    const files = [metadata(options.trustedConfigFile)]; let heartbeatText = '';
    let effectiveHeartbeatOverride: string | undefined;
    for (const [unit, fragment] of [[c.workerUnit, c.workerFragment], [c.heartbeatUnit, c.heartbeatFragment]]) {
      const p = properties(await run(['show', unit, '--property=FragmentPath,DropInPaths,LoadState,NeedDaemonReload,KillMode,SendSIGKILL,TimeoutStopUSec']));
      if (p.LoadState !== 'loaded' || p.FragmentPath !== fragment || (p.NeedDaemonReload !== 'no' && !(allowJournaledReload && p.NeedDaemonReload === 'yes'))) throw new Error('HEARTBEAT_EFFECTIVE_UNIT_UNKNOWN');
      if (unit === c.workerUnit && (p.KillMode !== 'process' || p.SendSIGKILL !== 'no' || p.TimeoutStopUSec !== 'infinity')) throw new Error('HEARTBEAT_UNSAFE_STOP_POLICY');
      const dropins = (p.DropInPaths || '').split(' ').filter(Boolean);
      // DropInPaths is systemd's resolved precedence inventory, not glob guessing.
      for (const file of [fragment, ...dropins]) {
        if (!/^\/[A-Za-z0-9_./-]+$/.test(file)) throw new Error('HEARTBEAT_DROPIN_PATH_UNSUPPORTED');
        files.push(metadata(file)); const text = fs.readFileSync(file, 'utf8');
        if (unit !== c.heartbeatUnit) continue;
        if (file === fragment) heartbeatText = text;
        if (/\\\r?\n|%/.test(text)) throw new Error('HEARTBEAT_COMPLEX_UNIT_UNSUPPORTED');
        // EnvironmentFile is applied after Environment irrespective of ordering;
        // reset/unset/pass/import environment can override or erase scope.
        if (/^\s*(EnvironmentFile|UnsetEnvironment|PassEnvironment|ImportEnvironment)\s*=/m.test(text)) throw new Error('HEARTBEAT_ENVIRONMENT_PRECEDENCE_CONFLICT');
        if (file !== fragment && /^\s*Exec[A-Za-z]+\s*=/m.test(text)) {
          // Accept only the executable-only form emitted by approved version
          // switches. All bytes remain journaled; the last resolved override
          // must select the installation policy's exact immutable closure.
          const match = /^\[Service\]\nExecStart=\nExecStart=(\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._-]+)\/bin\/tower-workbench-worker-heartbeat\n?$/.exec(text);
          if (!match || !c.storePath) throw new Error('HEARTBEAT_DROPIN_CONFLICT');
          effectiveHeartbeatOverride = match[1];
        } else if (file !== fragment && /^\s*(Environment|User|Group)\s*=/m.test(text)) throw new Error('HEARTBEAT_DROPIN_CONFLICT');
      }
    }
    if (effectiveHeartbeatOverride && effectiveHeartbeatOverride !== c.storePath) throw new Error('HEARTBEAT_BUILD_OVERRIDE_MISMATCH');
    let section = ''; const lines: string[] = [];
    for (const line of heartbeatText.split('\n')) {
      if (/^Environment=TOWER_LOCAL_WORKER_(ID|DEPLOYMENT_ID|IDENTITY_FILE)=/.test(line) && section !== '[Service]') throw new Error('HEARTBEAT_DIRECTIVE_SECTION_INVALID');
      if (/^\s*Environment\s*=/.test(line) && !/^Environment=[A-Z0-9_]+=[A-Za-z0-9_.,:/-]+$/.test(line)) throw new Error('HEARTBEAT_COMPLEX_ENVIRONMENT_UNSUPPORTED');
      if (/^\[.*\]$/.test(line)) section = line;
      if (/^\s*Environment\s*=/.test(line) && /TOWER_LOCAL_WORKER_PROJECT_IDS/.test(line)) {
        if (section !== '[Service]' || !/^Environment=TOWER_LOCAL_WORKER_PROJECT_IDS=[A-Za-z0-9_,-]+$/.test(line)) throw new Error('HEARTBEAT_SCOPE_LINE_UNSUPPORTED');
        lines.push(line);
      }
      if (/^\s*Environment\s*=\s*$/.test(line)) throw new Error('HEARTBEAT_ENVIRONMENT_RESET');
    }
    if (lines.length !== 1) throw new Error('HEARTBEAT_SCOPE_LINE_COUNT');
    for (const [key, value] of [['ID', c.workerId], ['DEPLOYMENT_ID', c.deploymentId], ['IDENTITY_FILE', c.identityFile]]) {
      const matches = heartbeatText.split('\n').filter(l => l.startsWith(`Environment=TOWER_LOCAL_WORKER_${key}=`));
      if (matches.length !== 1 || matches[0] !== `Environment=TOWER_LOCAL_WORKER_${key}=${value}`) throw new Error('HEARTBEAT_IDENTITY_CONFIG_MISMATCH');
    }
    return { files, line: lines[0], text: heartbeatText };
  }
  function checkEvidence(c: HeartbeatControlConfig, op: AssignmentOperation): HeartbeatScopeEvidence {
    const e = op.heartbeat;
    if (!e || e.version !== 1 || e.workerUnit !== c.workerUnit || e.heartbeatUnit !== c.heartbeatUnit || e.fragment.path !== c.heartbeatFragment
      || path.dirname(e.fragment.backup) !== c.backupDirectory || !sameIds(e.oldLine, op.oldScope) || !sameIds(e.newLine, op.newScope)) throw new Error('HEARTBEAT_JOURNAL_MISMATCH');
    const original = fs.readFileSync(metadata(e.fragment.backup).path, 'utf8');
    if (digest(original) !== e.fragment.sha256 || digest(replaceScopeLine(original, e.oldLine, e.newLine)) !== e.afterSha256) throw new Error('HEARTBEAT_BACKUP_CHANGED');
    return e;
  }
  function compare(c: HeartbeatControlConfig, e: HeartbeatScopeEvidence, current: Awaited<ReturnType<typeof inventory>>) {
    if (current.files.map(f => f.path).sort().join('\0') !== e.inventory.map(f => f.path).sort().join('\0')) throw new Error('HEARTBEAT_PRECEDENCE_CHANGED');
    for (const original of e.inventory) {
      const now = current.files.find(f => f.path === original.path)!;
      if (now.uid !== original.uid || now.gid !== original.gid || now.mode !== original.mode
        || (now.path === c.heartbeatFragment ? ![e.fragment.sha256, e.afterSha256].includes(now.sha256) : now.sha256 !== original.sha256)) throw new Error('HEARTBEAT_FILE_DRIFT');
    }
  }
  return {
    /** Same parser/inventory as apply, without owner/EX requirement or backups. */
    async preflightHeartbeat(scope:Scope):Promise<void> {
      const c=config(); const current=await inventory(c);
      if(!sameIds(current.line,scope))throw new Error('HEARTBEAT_EXISTING_SCOPE_MISMATCH');
    },
    async captureHeartbeatEvidence(scope: Scope, owner: string): Promise<HeartbeatScopeEvidence> {
      const c = config(); const op = await guard(c);
      if (op.id !== owner || op.phase !== 'heartbeat-plan-intent' || scopeDigest(scope) !== scopeDigest(op.newScope)) throw new Error('HEARTBEAT_PLAN_PHASE_INVALID');
      const current = await inventory(c);
      if (!sameIds(current.line, op.oldScope)) throw new Error('HEARTBEAT_EXISTING_SCOPE_MISMATCH');
      protectedPath(c.backupDirectory); const st = fs.statSync(c.backupDirectory);
      if (!st.isDirectory() || st.mode & 0o077) throw new Error('HEARTBEAT_BACKUP_DIRECTORY_UNSAFE');
      const file = path.join(c.backupDirectory, `${op.id}.heartbeat.backup`);
      if (fs.existsSync(file)) throw new Error('HEARTBEAT_BACKUP_EXISTS');
      durableWrite(file, current.text);
      const newLine = 'Environment=TOWER_LOCAL_WORKER_PROJECT_IDS=' + Object.keys(scope).sort().join(',');
      const fragment = current.files.find(f => f.path === c.heartbeatFragment)!;
      return { version: 1, workerUnit: c.workerUnit, heartbeatUnit: c.heartbeatUnit,
        fragment: { ...fragment, backup: file }, oldLine: current.line, newLine,
        afterSha256: digest(replaceScopeLine(current.text, current.line, newLine)), inventory: current.files };
    },
    async restart(scope: Scope): Promise<void> {
      const c = config(); const op = await guard(c); const e = checkEvidence(c, op);
      const rollback = op.phase === 'rollback-restart-intent';
      if ((!rollback && op.phase !== 'restart-intent') || scopeDigest(scope) !== scopeDigest(rollback ? op.oldScope : op.newScope)) throw new Error('HEARTBEAT_RESTART_PHASE_INVALID');
      const current = await inventory(c, true); compare(c, e, current);
      const expected = rollback ? e.fragment.sha256 : e.afterSha256;
      const recheck = async () => {
        const currentOwner = await guard(c);
        if (currentOwner.id !== op.id || currentOwner.phase !== op.phase || JSON.stringify(currentOwner.heartbeat) !== JSON.stringify(e)) throw new Error('HEARTBEAT_OPERATION_CHANGED');
        const latest = await inventory(c, true); compare(c, e, latest);
      };
      const original = fs.readFileSync(e.fragment.backup, 'utf8');
      // Crash after rename leaves a journaled before/after hash. A different hash
      // is never overwritten; a matching retry still requires explicit recovery.
      if (digest(current.text) !== expected) {
        await recheck();
        if (digest(fs.readFileSync(c.heartbeatFragment)) !== digest(current.text)) throw new Error('HEARTBEAT_CONCURRENT_WRITE');
        durableWrite(c.heartbeatFragment, rollback ? original : replaceScopeLine(original, e.oldLine, e.newLine), e.fragment);
      }
      await recheck();
      await run(['daemon-reload']);
      const loaded = await inventory(c); compare(c, e, loaded);
      if (digest(loaded.text) !== expected) throw new Error('HEARTBEAT_RELOAD_MISMATCH');
      await recheck(); await run(['restart', c.workerUnit, c.heartbeatUnit]);
      // Fresh PID/identity/heartbeat are verified by lifecycle.observe, not by a
      // successful systemctl client exit. Never clear owner here.
    },
    async preflightHeartbeatRestore(): Promise<void> {
      const c = config(); await options.authorize(c); const op = operation(c); const e = checkEvidence(c, op);
      compare(c, e, await inventory(c, true));
    },
    /** UNIT CONFIGURATION evidence only. Actual heartbeat PID/start time/token
     * and registered scope are independently required by lifecycle.observe. */
    async verifyHeartbeat(scope: Scope): Promise<void> {
      const c = config(); await options.authorize(c); const op = operation(c); const e = checkEvidence(c, op);
      const current = await inventory(c); compare(c, e, current);
      if (!sameIds(current.line, scope)) throw new Error('HEARTBEAT_LOADED_SCOPE_MISMATCH');
    },
  };
}
