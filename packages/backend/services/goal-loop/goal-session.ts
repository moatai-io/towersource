import { z } from 'zod';
import type { GoalState } from './goal-loop.js';
import { transitionGoal } from './goal-transition.js';
export { transitionGoal } from './goal-transition.js';

const text = z.string().trim().min(1).max(4000);
const evidence = z.object({ criterionId: text, revision: text, reference: text, passed: z.boolean() }).strict();
export const goalCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), goal: text, criteria: z.array(z.object({ id: text, description: text }).strict()).min(1).max(30), maxCycles: z.number().int().min(1).max(15).default(5) }).strict(),
  z.object({ action: z.literal('inspect'), decision: z.enum(['change', 'verify']), reason: text, strategyChanged: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('change'), revision: text }).strict(),
  z.object({ action: z.literal('check'), outcome: z.enum(['improved', 'unchanged', 'regressed', 'inconclusive']), evidence: z.array(evidence).max(30) }).strict(),
  z.object({ action: z.literal('stop'), status: z.enum(['needs_input', 'stopped']), reason: text }).strict(),
]);
export type GoalCommand = z.infer<typeof goalCommandSchema>;
export interface GoalScope { userId: number; projectId: string; sessionId: string; rootTurnId: string }
export interface GoalRecord { scope: GoalScope; version: number; state: GoalState; receipts: Record<string, string> }
export interface GoalStore {
  /** Must reauthorize scope and serialize read/transition/write in one transaction. */
  transact<T>(scope: GoalScope, fn: (record: GoalRecord | null) => { record: GoalRecord | null; result: T }, command?: GoalCommand): Promise<T>;
}

/** Scope comes only from the authenticated caller closure, never model arguments. */
export function createGoalSession(scope: GoalScope, store: GoalStore) {
  const boundScope = Object.freeze({ ...scope });
  if (!Number.isSafeInteger(scope.userId) || scope.userId <= 0 || !scope.projectId || !scope.sessionId || !scope.rootTurnId) throw new Error('INVALID_SCOPE');
  return {
    async status(): Promise<GoalRecord | null> {
      return store.transact(boundScope, record => {
        if (record && Object.keys(boundScope).some(k => record.scope[k as keyof GoalScope] !== boundScope[k as keyof GoalScope])) throw new Error('SCOPE_MISMATCH');
        return { record, result: structuredClone(record) };
      });
    },
    async execute(input: unknown): Promise<GoalRecord> {
      const request = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), expectedVersion: z.number().int().min(0), command: goalCommandSchema }).strict().parse(input);
      const fingerprint = JSON.stringify(request.command);
      return store.transact(boundScope, record => {
        if (record && Object.keys(boundScope).some(k => record.scope[k as keyof GoalScope] !== boundScope[k as keyof GoalScope])) throw new Error('SCOPE_MISMATCH');
        if (record && Object.hasOwn(record.receipts, request.requestId)) {
          if (record.receipts[request.requestId] !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
          return { record, result: structuredClone(record) };
        }
        if ((record?.version ?? 0) !== request.expectedVersion) throw new Error('STALE_VERSION');
        // Bounded by maxCycles*3 + start/stop. Never grow an unbounded receipt log.
        if (record && Object.keys(record.receipts).length >= 64) throw new Error('RECEIPT_BUDGET_EXHAUSTED');
        const next: GoalRecord = {
          scope: { ...boundScope }, version: (record?.version ?? 0) + 1,
          state: transitionGoal(record?.state ?? null, request.command),
          receipts: { ...record?.receipts, [request.requestId]: fingerprint },
        };
        return { record: next, result: structuredClone(next) };
      }, request.command);
    },
  };
}
