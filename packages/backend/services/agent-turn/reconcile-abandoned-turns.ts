// Reconcile expired owners without inferring process death from a different boot ID.
// Discovery/state repair only; the existing dispatcher and Pi claim own execution.
import { query } from '../../db/pg-repo.js';

export async function reconcileAbandonedAgentTurns(): Promise<number> {
  const rows = await query<{ root_turn_id: string }>(
    `WITH candidates AS (
       SELECT t.root_turn_id,
              EXISTS (SELECT 1 FROM side_effect_executions e
                       WHERE e.root_turn_id = t.root_turn_id
                         AND e.status IN ('running', 'uncertain')) AS uncertain
         FROM agent_turns t
         JOIN sessions s ON s.id = t.session_id
        WHERE t.state = 'running'
          AND s.engine = 'pi'
          AND t.waiting_user_started_at IS NULL
          AND COALESCE(t.last_failure_class,'') <> 'wait_requested'
          AND COALESCE(t.lease_until, t.updated_at + INTERVAL '180 seconds') <= NOW()
          AND COALESCE(t.accepted_at, t.created_at) >= NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (SELECT 1 FROM messages m
                           WHERE m.session_id = t.session_id AND m.role = 'user'
                             AND m.id <> t.root_turn_id
                             AND m.created_at > COALESCE(t.accepted_at, t.created_at))
        ORDER BY t.updated_at
        LIMIT 20
        FOR UPDATE OF t SKIP LOCKED
     )
     UPDATE agent_turns t
        SET state = CASE WHEN c.uncertain OR t.attempt_count >= 4
                         THEN 'needs_attention' ELSE 'waiting_retry' END,
            owner_token = NULL, owner_boot_id = NULL, lease_until = NULL,
            next_attempt_at = CASE WHEN c.uncertain OR t.attempt_count >= 4 THEN NULL ELSE NOW() END,
            terminal_at = CASE WHEN c.uncertain OR t.attempt_count >= 4 THEN NOW() ELSE NULL END,
            last_failure_class = CASE WHEN c.uncertain THEN 'abandoned_side_effect_uncertain'
                                      WHEN t.attempt_count >= 4 THEN 'auto_resume_attempts_exhausted'
                                      ELSE 'abandoned_owner' END,
            last_error = CASE WHEN c.uncertain THEN 'Execution was interrupted with an uncertain tool result; review is required.'
                              WHEN t.attempt_count >= 4 THEN 'Automatic recovery attempt limit reached.'
                              ELSE 'Execution owner lease expired; automatic recovery queued.' END,
            updated_at = NOW()
       FROM candidates c
      WHERE t.root_turn_id = c.root_turn_id
      RETURNING t.root_turn_id`,
    [],
  );
  return rows.length;
}
