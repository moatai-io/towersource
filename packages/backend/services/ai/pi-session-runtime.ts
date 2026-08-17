import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function getDataDir(projectRoot = process.cwd()): string {
  return path.join(projectRoot, 'data');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const PI_SESSION_BACKUP_MAX_BYTES = 128 * 1024 * 1024;

function backupKey(sessionFile: string): string {
  return crypto.createHash('sha1').update(path.resolve(sessionFile)).digest('hex');
}

export function getPiBackupPath(sessionFile: string, projectRoot = process.cwd()): string {
  return path.join(getDataDir(projectRoot), 'pi-session-backups', `${backupKey(sessionFile)}.json`);
}

export function backupPiSessionFile(sessionFile: string, projectRoot = process.cwd()): boolean {
  if (!sessionFile || !fs.existsSync(sessionFile)) return false;
  try {
    const size = fs.statSync(sessionFile).size;
    if (size > PI_SESSION_BACKUP_MAX_BYTES) {
      console.warn(`[pi] session backup skipped: file too large (${Math.round(size / 1024 / 1024)}MiB > ${Math.round(PI_SESSION_BACKUP_MAX_BYTES / 1024 / 1024)}MiB)`);
      return false;
    }
    const backupPath = getPiBackupPath(sessionFile, projectRoot);
    ensureDir(path.dirname(backupPath));
    fs.copyFileSync(sessionFile, backupPath);
    return true;
  } catch {
    return false;
  }
}

export function preparePiResumeSession(sessionFile: string, projectRoot = process.cwd()): string | undefined {
  if (!sessionFile) return undefined;
  if (fs.existsSync(sessionFile)) return sessionFile;

  const backupPath = getPiBackupPath(sessionFile, projectRoot);
  if (!fs.existsSync(backupPath)) return undefined;

  try {
    ensureDir(path.dirname(sessionFile));
    fs.copyFileSync(backupPath, sessionFile);
    return sessionFile;
  } catch {
    return undefined;
  }
}

export type InterruptedPiSession = { id: string; rootTurnId?: string };

export function gracefulPiShutdown(sessions: InterruptedPiSession[], projectRoot = process.cwd()): void {
  if (sessions.length === 0) return;
  try {
    // Atomic write: temp + renameSync — survives SIGKILL mid-write.
    // Mirrors claude-sdk.ts gracefulShutdown() rationale.
    // See: workspace/decisions/2026-05-17-restart-interrupted-session-recovery-fix.md
    const filePath = path.join(getDataDir(projectRoot), 'interrupted-pi-sessions.json');
    ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ sessions, at: new Date().toISOString() }));
    fs.renameSync(tmpPath, filePath);
  } catch {
    // best-effort only
  }
}

export function consumeInterruptedPiSessionDetails(projectRoot = process.cwd()): InterruptedPiSession[] {
  const filePath = path.join(getDataDir(projectRoot), 'interrupted-pi-sessions.json');
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    fs.unlinkSync(filePath);
    const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
    const sessions = rawSessions.flatMap((entry: unknown): InterruptedPiSession[] => {
      if (typeof entry === 'string') return [{ id: entry }];
      if (!entry || typeof entry !== 'object') return [];
      const id = typeof (entry as any).id === 'string' ? (entry as any).id : '';
      const rootTurnId = typeof (entry as any).rootTurnId === 'string' ? (entry as any).rootTurnId : undefined;
      return id ? [{ id, rootTurnId }] : [];
    });
    // Mirror claude-sdk.consumeInterruptedSessions() — without this log the
    // restart-recovery path was silent for Pi sessions and we couldn't verify
    // whether interrupted-pi-sessions.json was actually being written/read.
    // See: workspace/decisions/2026-05-17-restart-interrupted-session-recovery-fix.md
    if (sessions.length > 0) {
      console.log(`[pi] Recovered ${sessions.length} interrupted Pi session(s) from previous shutdown`);
    }
    return sessions;
  } catch {
    return [];
  }
}

/** Backward-compatible ID-only reader for engine-local startup callers. */
export function consumeInterruptedPiSessions(projectRoot = process.cwd()): string[] {
  return consumeInterruptedPiSessionDetails(projectRoot).map((session) => session.id);
}
