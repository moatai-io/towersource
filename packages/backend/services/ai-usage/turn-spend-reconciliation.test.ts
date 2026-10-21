import { describe, expect, it } from 'vitest';
import { reconcileTurnSpend } from './turn-spend-reconciliation.js';

const calls = [
  { requestId: 'request-a', terminalType: 'response.completed' },
  { requestId: 'request-b', terminalType: 'response.completed' },
];
const rows = [
  { requestId: 'request-a', rootTurnId: 'turn-1', spend: '0.00000003', status: 'success' },
  { requestId: 'request-b', rootTurnId: 'turn-1', spend: '0.00000004', status: 'success' },
];

describe('reconcileTurnSpend', () => {
  it('sums only fully matched per-call decimal spend without float rounding', () => {
    expect(reconcileTurnSpend('turn-1', calls, rows)).toEqual({ status: 'confirmed', costUsd: '0.00000007', matchedCalls: 2 });
  });
  it('deduplicates repeated evidence for the same completed request', () => {
    expect(reconcileTurnSpend('turn-1', [...calls, calls[0]], rows)).toEqual({ status: 'confirmed', costUsd: '0.00000007', matchedCalls: 2 });
    expect(reconcileTurnSpend('turn-1', [...calls, { requestId: 'request-a', terminalType: 'response.failed' }], rows)).toEqual({ status: 'pending', reason: 'unresolved_router_call' });
    expect(reconcileTurnSpend('turn-1', [...calls, { requestId: 'request-a', terminalType: 'response.failed' }, calls[0]], rows)).toEqual({ status: 'pending', reason: 'unresolved_router_call' });
    expect(reconcileTurnSpend('turn-1', [...calls, { requestId: 'request-a', terminalType: null }, calls[0]], rows)).toEqual({ status: 'pending', reason: 'unresolved_router_call' });
  });
  it('waits for delayed logs and rejects missing request IDs', () => {
    expect(reconcileTurnSpend('turn-1', calls, rows.slice(0, 1))).toEqual({ status: 'pending', reason: 'missing_spend_log' });
    expect(reconcileTurnSpend('turn-1', [{ requestId: null, terminalType: 'response.completed' }], rows)).toEqual({ status: 'pending', reason: 'missing_request_id' });
  });
  it('accepts a genuine zero-spend cached call but rejects imprecise or negative amounts', () => {
    expect(reconcileTurnSpend('turn-1', calls, [rows[0], { ...rows[1], spend: '0.00000000' }])).toEqual({ status: 'confirmed', costUsd: '0.00000003', matchedCalls: 2 });
    expect(reconcileTurnSpend('turn-1', calls, [rows[0], { ...rows[1], spend: '0.000000001' }])).toEqual({ status: 'pending', reason: 'unpriced_spend_log' });
    expect(reconcileTurnSpend('turn-1', calls, [rows[0], { ...rows[1], spend: '-0.01' }])).toEqual({ status: 'pending', reason: 'unpriced_spend_log' });
  });
  it('does not confirm failed, unpriced, duplicate or foreign rows', () => {
    expect(reconcileTurnSpend('turn-1', calls, [rows[0], { ...rows[1], spend: null }]).status).toBe('pending');
    expect(reconcileTurnSpend('turn-1', calls, [...rows, rows[0]]).status).toBe('pending');
    expect(reconcileTurnSpend('turn-1', calls, [rows[0], { ...rows[1], rootTurnId: 'other' }]).status).toBe('pending');
    expect(reconcileTurnSpend('turn-1', [{ requestId: 'request-a', terminalType: 'response.failed' }], rows).status).toBe('pending');
  });
});
