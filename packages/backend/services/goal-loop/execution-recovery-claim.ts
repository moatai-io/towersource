import type { PoolClient } from 'pg';
import { withClient } from '../../db/pg-repo.js';
import { claimAgentTurn } from '../agent-turn/turn-supervisor.js';
import { inspectExecutionRecovery } from './execution-recovery-safety.js';

/** Draft integration, no startup registration. Uses existing prototype lock order
 * goal -> session -> turn, matching goal stop/settlement. Call in one transaction.
 * Still NOT a fence against message/ACL writers that do not take these locks.
 */
export async function claimExecutionRecovery(client: PoolClient, input: {
  requestId: string; sessionId: string; ownerBootId: string;
}) {
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  const request = await client.query<{goal_id:string|null}>(
    'SELECT goal_id FROM execution_requests_draft WHERE id=$1 AND session_id=$2', [input.requestId,input.sessionId]);
  if (!request.rowCount || !input.ownerBootId) return { claimed: false as const, reason: 'missing_context' };
  if (request.rows[0].goal_id) await client.query('SELECT id FROM managed_goals WHERE id=$1 FOR UPDATE',[request.rows[0].goal_id]);
  await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[input.sessionId]);
  await client.query('SELECT root_turn_id FROM agent_turns WHERE root_turn_id=$1 AND session_id=$2 FOR UPDATE',[input.requestId,input.sessionId]);
  const eligibility = await inspectExecutionRecovery(client,input.requestId,input.sessionId);
  if(eligibility !== 'eligible') return {claimed:false as const,reason:eligibility};
  return claimAgentTurn({rootTurnId:input.requestId,sessionId:input.sessionId,ownerBootId:input.ownerBootId,
    source:'internal-request-recovery',maxAttempts:4},withClient(client).queryOne);
}
