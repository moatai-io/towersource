import { createHash } from 'node:crypto';
import { z } from 'zod';
import { goalCommandSchema, type GoalRecord, type GoalScope } from './goal-session.js';

const text = z.string().trim().min(1).max(4000);
const receiptSchema = z.object({
  id: text,
  scope: z.object({ userId: z.number().int().positive(), projectId: text, sessionId: text, rootTurnId: text }).strict(),
  criterionId: text,
  criterionHash: z.string().regex(/^[a-f0-9]{64}$/),
  revision: text,
  verifierId: text,
  status: z.enum(['passed', 'failed', 'inconclusive']),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
}).strict();
export type GoalEvidenceReceipt = z.infer<typeof receiptSchema>;
export type GoalCheckCommand = Extract<z.infer<typeof goalCommandSchema>, { action: 'check' }>;
export function criterionHash(criterion: { id: string; description: string }): string {
  return createHash('sha256').update(JSON.stringify([criterion.id, criterion.description])).digest('hex');
}
export interface EvidenceSnapshot {
  record: GoalRecord;
  /** Server-derived current artifact digest. Never accept a model-supplied digest. */
  artifactDigest: string;
  /** Immutable server-issued receipts, resolved under the same authorized snapshot. */
  receipts: unknown[];
}

/** Pure validator. Receipt issuance, revision tracking and artifact hashing remain host responsibilities. */
export function verifyGoalEvidenceSnapshot(
  scope: GoalScope,
  expectedVersion: number,
  command: GoalCheckCommand,
  snapshot: EvidenceSnapshot,
  trustedVerifierIds: ReadonlySet<string>,
): boolean {
  const state = snapshot.record.state;
  if (snapshot.record.version !== expectedVersion || state.status !== 'running' || state.phase !== 'check') return false;
  if (Object.keys(scope).some(k => scope[k as keyof GoalScope] !== snapshot.record.scope[k as keyof GoalScope])) return false;
  if (!/^[a-f0-9]{64}$/.test(snapshot.artifactDigest)) return false;
  const parsed = snapshot.receipts.map(r => receiptSchema.safeParse(r));
  if (parsed.some(r => !r.success)) return false;
  const receipts = parsed.flatMap(r => r.success ? [r.data] : []);
  if (new Set(receipts.map(r => r.id)).size !== receipts.length) return false;
  if (!command.evidence.length) return command.outcome === 'inconclusive';
  if (new Set(command.evidence.map(e => e.criterionId)).size !== command.evidence.length) return false;
  for (const evidence of command.evidence) {
    const criterion = state.criteria.find(c => c.id === evidence.criterionId);
    const receipt = receipts.find(r => r.id === evidence.reference);
    if (!criterion || !receipt || receipt.criterionId !== criterion.id || receipt.criterionHash !== criterionHash(criterion)) return false;
    if (Object.keys(scope).some(k => scope[k as keyof GoalScope] !== receipt.scope[k as keyof GoalScope])) return false;
    if (evidence.revision !== state.revision || receipt.revision !== state.revision) return false;
    if (!trustedVerifierIds.has(receipt.verifierId) || receipt.artifactDigest !== snapshot.artifactDigest) return false;
    if (receipt.status === 'inconclusive' || evidence.passed !== (receipt.status === 'passed')) return false;
  }
  return true;
}

export interface GoalEvidenceReader {
  /** Must reauthorize and return a coherent immutable snapshot. This is not a write fence. */
  snapshot(scope: GoalScope, references: string[]): Promise<EvidenceSnapshot | null>;
}
export function createGoalEvidenceVerifier(reader: GoalEvidenceReader, trustedVerifierIds: ReadonlySet<string>) {
  const trusted = new Set(trustedVerifierIds);
  return async (scope: GoalScope, command: GoalCheckCommand, expectedVersion: number): Promise<boolean> => {
    try {
      const parsed = goalCommandSchema.parse(command);
      if (parsed.action !== 'check') return false;
      const snapshot = await reader.snapshot(scope, parsed.evidence.map(e => e.reference));
      return snapshot !== null && verifyGoalEvidenceSnapshot(scope, expectedVersion, parsed, snapshot, trusted);
    } catch { return false; }
  };
}
