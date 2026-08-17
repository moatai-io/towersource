import { describe, expect, it } from 'vitest';
import { decideRouterReconciliation } from './router-evidence.js';

describe('router evidence reconciliation', () => {
  it('never treats router completion alone as Tower completion authority', () => {
    expect(decideRouterReconciliation({
      terminalType: 'response.completed',
      durableAssistant: false,
    })).toEqual({
      action: 'needs_reconciliation',
      reason: 'router_completed_without_durable_assistant',
    });
  });

  it('allows completion only when Tower already has a durable assistant', () => {
    expect(decideRouterReconciliation({
      terminalType: 'response.completed',
      durableAssistant: true,
    })).toEqual({
      action: 'complete',
      reason: 'durable_assistant_and_router_completed',
    });
  });

  it('keeps router failure as retry evidence rather than an automatic replay command', () => {
    expect(decideRouterReconciliation({
      terminalType: 'response.incomplete',
      durableAssistant: false,
    })).toEqual({
      action: 'retry_eligible',
      reason: 'router_failed_without_durable_assistant',
    });
  });
});
