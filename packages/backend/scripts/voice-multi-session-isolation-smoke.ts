/** Secret-free smoke for parallel voice turns across durable Tower Sessions. */
import { createSession } from '../services/session/session-manager.js';
import { execute, query, queryOne } from '../db/pg-repo.js';
import { runTowerVoiceTurn } from '../services/voice-runtime/tower-session-turn-gateway.js';

const PROJECT_ID = '7d84f926-1fcd-438d-94dc-a36048636bad';
const USER_ID = 1;
const CWD = '/home/tower/tower';

async function createTestSession(index: number) {
  return createSession(
    `[voice-smoke] parallel-${index}-${Date.now()}`,
    CWD,
    USER_ID,
    PROJECT_ID,
    'pi',
    null,
    null,
    null,
    'voice-isolation-smoke',
    'litellm-responses/mini',
    { visibility: 'private' },
  );
}

async function archive(ids: string[]) {
  if (ids.length > 0) await execute('UPDATE sessions SET archived=1 WHERE id=ANY($1::text[])', [ids]);
}

async function main() {
  const baseline = await query<{ id: string; turn_count: number }>(
    `SELECT id,turn_count FROM sessions WHERE user_id=$1 AND archived=0 AND label IS DISTINCT FROM 'voice-isolation-smoke'`,
    [USER_ID],
  );
  const baselineCounts = new Map(baseline.map((row) => [row.id, Number(row.turn_count || 0)]));
  const sessions = await Promise.all([1, 2, 3].map(createTestSession));
  const ids = sessions.map((session) => session.id);
  try {
    const started = Date.now();
    const results = await Promise.all(ids.map((sessionId, index) => runTowerVoiceTurn({
      sessionId,
      userId: USER_ID,
      transcript: `병렬 격리 테스트 ${index + 1}입니다. 숫자 ${index + 1}만 답하세요.`,
    })));
    const parallelPass = results.every((text, index) => text.includes(String(index + 1)));

    const sameSession = ids[0];
    const first = runTowerVoiceTurn({ sessionId: sameSession, userId: USER_ID, transcript: '3초 정도 생각한 뒤 첫 번째라고 답하세요.' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await runTowerVoiceTurn({ sessionId: sameSession, userId: USER_ID, transcript: '두 번째라고 답하세요.' });
    await first;
    const sameSessionBusyPass = second.includes('이전 음성 답변');

    const missingRejected = await runTowerVoiceTurn({
      sessionId: '00000000-0000-0000-0000-000000000001', userId: USER_ID, transcript: '실패 격리',
    }).then(() => false, () => true);

    const changed = await query<{ id: string; turn_count: number }>(
      `SELECT id,turn_count FROM sessions WHERE id=ANY($1::text[])`,
      [[...baselineCounts.keys()]],
    );
    const unrelatedPass = changed.every((row) => Number(row.turn_count || 0) === baselineCounts.get(row.id));
    const testRows = await query<{ id: string; turn_count: number }>(
      `SELECT id,turn_count FROM sessions WHERE id=ANY($1::text[]) ORDER BY id`, [ids],
    );
    const testCountsPass = testRows.reduce((sum, row) => sum + Number(row.turn_count || 0), 0) === 4;
    const active = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_turns WHERE session_id=ANY($1::text[]) AND state IN ('running','stop_requested','waiting_retry')`,
      [ids],
    ).catch(() => ({ count: '0' }));
    const settledPass = Number(active?.count || 0) === 0;

    console.log([
      `parallel=${parallelPass ? 'pass' : 'fail'}`,
      `same_session_busy=${sameSessionBusyPass ? 'pass' : 'fail'}`,
      `failure_isolation=${missingRejected ? 'pass' : 'fail'}`,
      `unrelated_sessions=${unrelatedPass ? 'pass' : 'fail'}`,
      `test_turn_counts=${testCountsPass ? 'pass' : 'fail'}`,
      `settled=${settledPass ? 'pass' : 'fail'}`,
      `duration_ms=${Date.now() - started}`,
    ].join(' '));
    if (![parallelPass, sameSessionBusyPass, missingRejected, unrelatedPass, testCountsPass, settledPass].every(Boolean)) process.exitCode = 1;
  } finally {
    await archive(ids);
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
  console.error(`voice_multi_session_smoke=fail error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
