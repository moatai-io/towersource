import type { TransactionalGoalGuard } from './goal-store.js';
import type { EvidenceSnapshot } from './goal-evidence.js';
import { verifyGoalEvidenceSnapshot } from './goal-evidence.js';
import type { GoalScope, GoalRecord } from './goal-session.js';
import type { PoolClient } from 'pg';

export interface GoalGuardBinding {
  ownerToken: string;
  ownerBootId: string;
  /** Explicit opt-in comes from host authorization, not model goal_start. */
  goalAuthorized: boolean;
  /** Exact current wrapper execution, closure-supplied per call; never a model argument.
   * Exclude only its own running goal_step receipt, never an uncertain receipt.
   */
  currentGoalExecutionId?: string;
  trustedVerifierIds: ReadonlySet<string>;
  /** Read locked immutable receipts and a fenced artifact revision using this client. */
  evidenceSnapshot(client: PoolClient, scope: GoalScope, previous: GoalRecord, references: string[]): Promise<EvidenceSnapshot | null>;
}

/** Concrete turn-fencing check. Never creates/reclaims an agent-turn owner. */
export function createTransactionalGoalGuard(binding: GoalGuardBinding): TransactionalGoalGuard {
  const token = binding.ownerToken;
  const boot = binding.ownerBootId;
  const enabled = binding.goalAuthorized;
  const trusted = new Set(binding.trustedVerifierIds);
  return {
    async validate(client, scope, previous, command) {
      if (!enabled || !token || !boot) return false;
      // Lock ordering: session -> goal -> turn. Stop/dispatch integration must use
      // the same order; no external callback may be dispatched while holding locks.
      const owned = await client.query(
        `SELECT t.root_turn_id FROM agent_turns t
         JOIN messages root ON root.id = t.root_turn_id
         WHERE t.root_turn_id = $1 AND t.session_id = $2
           AND t.owner_token = $3 AND t.owner_boot_id = $4
           AND t.state = 'running' AND t.lease_until > NOW()
           AND t.waiting_user_started_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM messages newer WHERE newer.session_id = t.session_id
               AND newer.role = 'user' AND newer.id <> root.id
               AND newer.created_at >= root.created_at)
           AND NOT EXISTS (
             SELECT 1 FROM side_effect_executions e WHERE e.root_turn_id = t.root_turn_id
               AND (e.status = 'uncertain' OR (e.status = 'running'
                 AND NOT (e.id = COALESCE($5, '') AND e.tool_name = 'goal_step'))))
         FOR UPDATE OF t`,
        [scope.rootTurnId, scope.sessionId, token, boot, binding.currentGoalExecutionId ?? null],
      );
      if (owned.rowCount !== 1) return false;
      if (command.action !== 'check') return true;
      if (!previous) return false;
      const snapshot = await binding.evidenceSnapshot(client, scope, previous, command.evidence.map(e => e.reference));
      return snapshot !== null && verifyGoalEvidenceSnapshot(scope, previous.version, command, snapshot, trusted);
    },
  };
}
