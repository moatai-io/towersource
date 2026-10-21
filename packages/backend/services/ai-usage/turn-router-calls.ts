// Read-only, bounded evidence lookup for one root turn. No provider traffic or billing mutation.
import { query } from '../../db/pg-repo.js';
import type { ObservedRouterCall } from './turn-spend-reconciliation.js';

/** Preserve every observed request, including null IDs and non-completed terminals.
 * Callers must not silently drop these rows when deciding whether spend is complete.
 */
export async function getObservedRouterCalls(rootTurnId: string): Promise<ObservedRouterCall[]> {
  if (!rootTurnId.trim()) throw new Error('rootTurnId is required');
  const rows = await query<{ requestId: string | null; terminalType: string | null }>(`
    SELECT request_id AS "requestId", terminal_type AS "terminalType"
      FROM agent_turn_router_evidence
     WHERE root_turn_id = $1
     ORDER BY observed_at ASC, id ASC
     LIMIT 501
  `, [rootTurnId]);
  // A truncated set could falsely appear fully reconciled. Fail closed.
  if (rows.length > 500) throw new Error('router evidence exceeds per-turn reconciliation limit');
  return rows;
}
