// Preview only: no ledger updates, status-line changes, retries or scheduled work.
import { getObservedRouterCalls } from './turn-router-calls.js';
import { fetchLiteLLMTurnSpend } from './litellm-turn-spend-client.js';
import { reconcileTurnSpend, type TurnSpendResult } from './turn-spend-reconciliation.js';

/** Caller must opt in to the unverified Router endpoint; never run on turn completion. */
export async function previewTurnSpend(rootTurnId: string, signal?: AbortSignal): Promise<TurnSpendResult> {
  // Read local evidence first. Do not contact Router when a turn is already
  // ineligible for confirmation (missing request IDs or conflicting terminals).
  const observed = await getObservedRouterCalls(rootTurnId);
  const eligibility = reconcileTurnSpend(rootTurnId, observed, []);
  if (eligibility.status === 'pending' && eligibility.reason !== 'missing_spend_log') return eligibility;
  const spendRows = await fetchLiteLLMTurnSpend(rootTurnId, signal);
  return reconcileTurnSpend(rootTurnId, observed, spendRows);
}
