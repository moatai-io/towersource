import { query } from '../../db/pg-repo.js';
import { getAllRunningSessionIds } from '../../engines/index.js';
import { handleChat } from '../../routes/ws-handler.js';
import { listDueWaitAlarms, assertWaitPrincipal, invalidateWaitAlarm, retireSupersededWaitRetries } from './alarms.js';
import type { WebSocket } from 'ws';

let timer: ReturnType<typeof setInterval> | undefined;
let scanning = false;
const inFlight = new Set<string>();
export async function dispatchWaitAlarms() {
  if (scanning) return;
  scanning = true;
  try {
    await retireSupersededWaitRetries();
    for (const alarm of await listDueWaitAlarms()) {
      if(inFlight.size >= 4) break;
      if (inFlight.has(alarm.session_id) || getAllRunningSessionIds().includes(alarm.session_id)) continue;
      let actor;
      try { actor = await assertWaitPrincipal(alarm.session_id, alarm.owner_user_id); }
      catch { await invalidateWaitAlarm(alarm.session_id); continue; }
      const sink = { readyState: 1, send() {} } as unknown as WebSocket;
      inFlight.add(alarm.session_id);
      void handleChat({ id: `wait-${alarm.id}`, ws: sink, userId: alarm.owner_user_id,
        userRole: actor.role, username: actor.username, activeQueryEpoch: 0, joinedRooms: new Set() },
        { sessionId: alarm.session_id, messageId: alarm.resume_message_id,
          message: `[대기 알람] ${alarm.reason}\n대기 시간이 지났습니다. 최신 사용자 지시와 현재 상태를 확인하고 이전 작업을 이어가세요. 추가 승인이 필요한 행동은 실행하지 마세요.`,
          headless: true, suppressUserEcho: true, waitAlarmId: alarm.id, waitAlarmVersion: alarm.version }).catch(error => console.warn('[wait-alarm] admission failed', error instanceof Error ? error.message : 'unknown')).finally(() => inFlight.delete(alarm.session_id));
    }
  } finally { scanning = false; }
}
/** Reconcile persisted parked roots before ordinary interrupted-turn recovery. */
export async function reconcileWaitAlarmRoots() {
  await query(`UPDATE session_wait_alarms a SET status='pending',updated_at=NOW() WHERE a.status='admitted' AND NOT EXISTS(SELECT 1 FROM agent_turns t WHERE t.root_turn_id=a.resume_message_id)`);
  await query(`UPDATE agent_turns t SET state='completed',owner_token=NULL,owner_boot_id=NULL,lease_until=NULL,next_attempt_at=NULL,completed_at=NOW(),terminal_at=NOW(),updated_at=NOW()
    WHERE EXISTS(SELECT 1 FROM session_wait_alarms a WHERE a.source_root_turn_id=t.root_turn_id)
    AND t.last_failure_class='wait_requested'
    AND (t.lease_until IS NULL OR t.lease_until<=NOW())
    AND t.state NOT IN ('completed','failed','needs_attention')`);
}
export function startWaitAlarmDispatcher() {
  if(timer) return;
  timer = setInterval(() => { void dispatchWaitAlarms().catch(error => console.warn('[wait-alarm]', error)); }, 10_000);
  timer.unref();
  void dispatchWaitAlarms().catch(error => console.warn('[wait-alarm]', error));
}
export function stopWaitAlarmDispatcher() { if(timer) clearInterval(timer); timer=undefined; }
