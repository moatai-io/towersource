import { randomUUID } from 'node:crypto';
import { criterionHash, type GoalEvidenceReceipt } from './goal-evidence.js';
import type { GoalScope } from './goal-session.js';

export interface CheckerBinding {
  scope: GoalScope;
  criterion: { id: string; description: string };
  revision: string;
  verifierId: string;
  /** Host-approved bounded checker, never an arbitrary model-supplied command. */
  execute(signal: AbortSignal): Promise<'passed' | 'failed' | 'inconclusive'>;
}
export interface CheckerHost {
  authorize(binding: CheckerBinding): Promise<boolean>;
  /** Read-only server digest of the complete relevant artifact set. */
  digest(binding: CheckerBinding): Promise<string>;
  /** Must fence ownership/current revision and digest at receipt commit. */
  commit(receipt: GoalEvidenceReceipt): Promise<boolean>;
}

/** Issues a receipt from a host-bound checker. No public tool may supply binding callbacks.
 * Abort is cooperative; no retry/receipt is issued for ambiguous checker execution.
 */
export async function issueGoalReceipt(binding: CheckerBinding, host: CheckerHost, signal: AbortSignal): Promise<GoalEvidenceReceipt | null> {
  if (signal.aborted || !await host.authorize(binding)) return null;
  const digest = await host.digest(binding);
  if (!/^[a-f0-9]{64}$/.test(digest) || signal.aborted) return null;
  const status = await binding.execute(signal);
  if (!['passed', 'failed', 'inconclusive'].includes(status) || signal.aborted) return null;
  if (!await host.authorize(binding) || await host.digest(binding) !== digest || signal.aborted) return null;
  const receipt: GoalEvidenceReceipt = {
    id: randomUUID(), scope: { ...binding.scope }, criterionId: binding.criterion.id,
    criterionHash: criterionHash(binding.criterion), revision: binding.revision,
    verifierId: binding.verifierId, status, artifactDigest: digest, createdAt: new Date().toISOString(),
  };
  return await host.commit(receipt) ? receipt : null;
}
