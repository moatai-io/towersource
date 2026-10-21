/** Default-on disk monitoring; backup deletion requires separate explicit opt-in. */
import { statfs, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { config } from '../../config.js';
import { getPgPool } from '../../db/pg.js';
import { notify } from '../notification-hub.js';
import { diskLevel, shouldNotify, type DiskLevel } from './policy.js';
const execute = promisify(execFile);
interface State { level: DiskLevel; lastSent: number; lastBackup: number; backupNotice?: string; }
export function startServerMaintenance(): void {
  // A legacy master switch can still disable everything, but never enables deletion.
  if (process.env.TOWER_SERVER_MAINTENANCE_ENABLED === '0') return;
  const diskEnabled = process.env.TOWER_DISK_MONITOR_ENABLED !== '0';
  const backupEnabled = process.env.TOWER_BACKUP_RETENTION_ENABLED === '1';
  const stateDir = process.env.TOWER_SERVER_MAINTENANCE_STATE_DIR || path.join(config.dataDir, 'server-maintenance');
  const script = process.env.TOWER_BACKUP_RETENTION_SCRIPT;
  const diskPath = process.env.TOWER_DISK_MONITOR_PATH || config.dataDir;
  let roots: unknown = [];
  let backupError = '';
  try { roots = JSON.parse(process.env.TOWER_BACKUP_RETENTION_ROOTS || '[]'); }
  catch { backupError = 'invalid'; }
  const rootsValid = Array.isArray(roots) && roots.length > 0
    && roots.every(r => typeof r === 'string' && path.isAbsolute(r));
  if (!rootsValid || !script || !path.isAbsolute(script)) backupError = 'invalid';
  if (!diskEnabled && !backupEnabled && !rootsValid) return;
  const backupRoots = rootsValid ? roots as string[] : [];
  const statePath = path.join(stateDir, 'state.json');
  let busy = false;
  const send = async (title: string, body: string, critical = false) => {
    const { rows: admins } = await getPgPool().query<{ id: number }>("SELECT id FROM users WHERE role = 'admin'");
    if (!admins.length) throw new Error('No administrator recipients');
    for (const admin of admins) await notify(admin.id, 'system.server-maintenance', title, body, undefined,
      { priority: critical ? 'urgent' : 'normal', defaultChannels: ['in_app', 'web_push'] });
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      let state: State = { level: 'normal', lastSent: 0, lastBackup: 0 };
      try { state = JSON.parse(await readFile(statePath, 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const now = Date.now();
      if (diskEnabled) {
      const fs = await statfs(diskPath);
      const available = fs.bavail * fs.bsize;
      const level = diskLevel(available);
      if (shouldNotify(level, state.level, now, state.lastSent)) {
        await send(level === 'normal' ? '서버 디스크 공간 회복' : level === 'critical' ? '서버 디스크 공간 긴급 경고' : '서버 디스크 공간 부족',
          `가용 공간 ${(available / 2 ** 30).toFixed(1)}GiB. 경고 기준 50GiB, 긴급 기준 20GiB.`, level === 'critical');
        state.level = level; state.lastSent = now;
      }
      }
      const notice = backupEnabled && backupError ? 'invalid' : !backupEnabled && rootsValid ? 'disabled' : '';
      if (notice && state.backupNotice !== notice) {
        await send('서버 백업 보존 설정 확인',
          notice === 'invalid' ? '자동 정리가 요청되었지만 백업 경로 또는 스크립트 설정이 잘못되었습니다. 삭제는 실행하지 않습니다.'
            : '백업 경로가 설정되어 있지만 자동 정리는 비활성화 상태입니다. 보존 정책을 승인한 후 별도로 활성화하세요.');
        state.backupNotice = notice;
      } else if (!notice) { state.backupNotice = ''; }
      if (backupEnabled && !backupError && now - state.lastBackup >= 86400_000) {
        try {
          const result = await execute('python3', [script!, '--apply', ...backupRoots.flatMap(r => ['--root', r])],
            { timeout: 300_000, maxBuffer: 1024 * 1024 });
          const summary = JSON.parse(result.stdout);
          console.info('[server-maintenance] backup retention', JSON.stringify({ count: summary.count, bytes: summary.bytes }));
        } catch {
          await send('서버 백업 보존 작업 실패', '보존 백업 검증 또는 정리 실행이 실패했습니다. 운영자가 백업과 실행 기록을 확인해야 합니다.', true);
        }
        state.lastBackup = now;
      }
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${statePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, statePath);
    } catch { console.error('[server-maintenance] Maintenance failed; inspect disk, state and notification delivery'); }
    finally { busy = false; }
  };
  void tick();
  setInterval(() => void tick(), 15 * 60_000).unref();
}
