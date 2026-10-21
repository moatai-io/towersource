// Owns the bounded, pure matching step between a Tower root turn's observed
// Router calls and LiteLLM SpendLogs. It does not query provider databases or
// promote estimates to confirmed costs without complete evidence.
export interface ObservedRouterCall {
  requestId: string | null;
  terminalType: string | null;
}

export interface RouterSpendRow {
  requestId: string;
  spend: string | number | null;
  rootTurnId: string;
  status: string;
}

// The evidence table can contain more than one lifecycle row per HTTP call.
// Preserve only complete request IDs; a conflicting terminal is not safe to bill.
export function collapseObservedCalls(rows: ObservedRouterCall[]): ObservedRouterCall[] {
  const byId = new Map<string, ObservedRouterCall>();
  const missing: ObservedRouterCall[] = [];
  for (const row of rows) {
    if (!row.requestId) { missing.push(row); continue; }
    const existing = byId.get(row.requestId);
    // Distinct terminal outcomes for one ID are ambiguous. Do not let a
    // later duplicate erase the conflict, including an untyped observation.
    byId.set(row.requestId, existing && existing.terminalType !== row.terminalType
      ? { requestId: row.requestId, terminalType: 'conflicting_terminal' }
      : existing?.terminalType === 'conflicting_terminal' ? existing : row);
  }
  return [...byId.values(), ...missing];
}

export type TurnSpendResult =
  | { status: 'confirmed'; costUsd: string; matchedCalls: number }
  | { status: 'pending'; reason: 'missing_request_id' | 'missing_spend_log' | 'unpriced_spend_log' | 'unresolved_router_call' | 'unexpected_spend_log' };

// Money is kept in integer 1e-8 USD units to avoid floating-point addition.
// LiteLLM's canonical decimal string should be carried through to persistence.
function parseSpend(value: string | number | null): bigint | null {
  if (value === null) return null;
  const text = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) return null;
  return BigInt(match[1]) * 100_000_000n + BigInt((match[2] ?? '').padEnd(8, '0'));
}

function formatSpend(units: bigint): string {
  return `${units / 100_000_000n}.${String(units % 100_000_000n).padStart(8, '0')}`;
}

/** Confirm only when every observed call matches exactly one successful SpendLog. */
export function reconcileTurnSpend(rootTurnId: string, observed: ObservedRouterCall[], spendRows: RouterSpendRow[]): TurnSpendResult {
  const calls = collapseObservedCalls(observed);
  if (!calls.length || calls.some(call => !call.requestId)) return { status: 'pending', reason: 'missing_request_id' };
  if (calls.some(call => call.terminalType !== 'response.completed')) return { status: 'pending', reason: 'unresolved_router_call' };
  const ids = new Set(calls.map(call => call.requestId));
  const rows = new Map<string, RouterSpendRow>();
  for (const row of spendRows) {
    if (row.rootTurnId !== rootTurnId || !ids.has(row.requestId) || rows.has(row.requestId)) {
      return { status: 'pending', reason: 'unexpected_spend_log' };
    }
    rows.set(row.requestId, row);
  }
  if (rows.size !== ids.size) return { status: 'pending', reason: 'missing_spend_log' };
  let total = 0n;
  for (const id of ids) {
    const row = rows.get(id!);
    const amount = parseSpend(row?.spend ?? null);
    if (!row || row.status !== 'success' || amount === null) return { status: 'pending', reason: 'unpriced_spend_log' };
    total += amount;
  }
  return { status: 'confirmed', costUsd: formatSpend(total), matchedCalls: ids.size };
}
