/**
 * idle-stop-cron.ts — Box idle stop + Service TTL 만료 cron.
 *
 * Owns: 비활성 Box 자동 stop, 만료 서비스 정리.
 * Public API: startRuntimeBoxCron(), stopRuntimeBoxCron().
 * See README.md.
 *
 * 동작:
 *   - 1분마다: Docker/container/process 상태 reconcile
 *   - 1분마다: running box 중 last_active_at 이 idle_stop_minutes 이상 지난 것 stop
 *   - 1분마다: expires_at 지난 unpinned 서비스 expire
 */

import { query } from '../../db/pg-repo.js';
import { expireStaleServices, reconcileRuntimeBoxServices } from './service-registry.js';
import { reconcileStaleWorkbenchJobs } from '../execution/jobs/job-registry.js';
import { countRunningBoxes, stopBox, reconcileRuntimeBoxes } from './runtime-box-manager.js';
import type { BoxRow } from './types.js';
// Note: countRunningBoxes / countRunningBoxesByUser / assertGlobalBoxBudget / assertUserBoxBudget
// 은 runtime-box-manager.ts 에서 직접 import. 여기서 re-export 하지 않음 (barrel 금지 규칙).

let cronHandle: ReturnType<typeof setInterval> | null = null;

/**
 * 서버 시작 시 1회 호출. 백그라운드 cron 시작.
 * 반드시 stopRuntimeBoxCron() 과 쌍으로 사용.
 */
export function startRuntimeBoxCron(): void {
  if (cronHandle) return; // 중복 방지

  // Startup reconciliation runs immediately so stale Job leases do not remain
  // falsely running for the first minute after a backend replacement.
  void runRuntimeBoxMaintenance('startup');
  cronHandle = setInterval(() => { void runRuntimeBoxMaintenance('tick'); }, 60_000);

  console.log('[runtime-box-cron] started (startup reconcile + 60s tick)');
}

async function runRuntimeBoxMaintenance(source: 'startup' | 'tick'): Promise<void> {
  try {
    const runningCount = await countRunningBoxes();
    if (runningCount > 0) console.log(`[runtime-box-cron] ${source}: ${runningCount} running box(es)`);
    const boxChanges = await reconcileRuntimeBoxes();
    const serviceChanges = await reconcileRuntimeBoxServices();
    if (boxChanges > 0 || serviceChanges > 0) {
      console.log(`[runtime-box-cron] reconcile: boxes=${boxChanges}, services=${serviceChanges}`);
    }
    await idleStopRunningBoxes();
    await expireStaleServices();
    const staleJobs = await reconcileStaleWorkbenchJobs();
    if (staleJobs > 0) console.warn(`[runtime-box-cron] failed ${staleJobs} Workbench Job(s) with expired runner leases`);
  } catch (e) {
    // Maintenance failure must never take down the backend.
    console.error(`[runtime-box-cron] ${source} error:`, (e as Error).message);
  }
}

/** 서버 종료 시 호출. */
export function stopRuntimeBoxCron(): void {
  if (cronHandle) {
    clearInterval(cronHandle);
    cronHandle = null;
    console.log('[runtime-box-cron] stopped');
  }
}

// ── idle stop 로직 ────────────────────────────────────────────────────────

/**
 * running box 중 idle_stop_minutes 이상 활동 없는 것을 'idle_stopped' 로 전환.
 * stopBox(id, 'idle_stopped') 를 통해 Docker stop + DB 상태 갱신 수행.
 */
async function idleStopRunningBoxes(): Promise<void> {
  const boxesToStop = await query<Pick<BoxRow, 'id'>>(
    `SELECT id FROM project_runtime_boxes
     WHERE status = 'running'
       AND last_active_at IS NOT NULL
       AND last_active_at + (idle_stop_minutes * interval '1 minute') < now()`,
  );

  for (const box of boxesToStop) {
    try {
      await stopBox(box.id, 'idle_stopped');
      console.log(`[runtime-box-cron] idle-stopped box ${box.id}`);
    } catch (e) {
      console.error(`[runtime-box-cron] failed to idle-stop box ${box.id}:`, (e as Error).message);
    }
  }
}
