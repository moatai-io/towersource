import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ observed: vi.fn(), spend: vi.fn() }));
vi.mock('./turn-router-calls.js', () => ({ getObservedRouterCalls: mocks.observed }));
vi.mock('./litellm-turn-spend-client.js', () => ({ fetchLiteLLMTurnSpend: mocks.spend }));
import { previewTurnSpend } from './turn-spend-preview.js';

beforeEach(() => { mocks.observed.mockReset(); mocks.spend.mockReset(); });

describe('opt-in turn spend preview', () => {
  it('never contacts Router when local evidence is incomplete', async () => {
    mocks.observed.mockResolvedValue([{ requestId: null, terminalType: 'response.completed' }]);
    expect(await previewTurnSpend('turn-1')).toEqual({ status: 'pending', reason: 'missing_request_id' });
    expect(mocks.spend).not.toHaveBeenCalled();
  });
  it('matches all observed calls against the bounded Router response', async () => {
    mocks.observed.mockResolvedValue([
      { requestId: 'a', terminalType: 'response.completed' },
      { requestId: 'b', terminalType: 'response.completed' },
    ]);
    mocks.spend.mockResolvedValue([
      { requestId: 'a', rootTurnId: 'turn-1', spend: '0.00000001', status: 'success' },
      { requestId: 'b', rootTurnId: 'turn-1', spend: '0.00000002', status: 'success' },
    ]);
    expect(await previewTurnSpend('turn-1')).toEqual({ status: 'confirmed', costUsd: '0.00000003', matchedCalls: 2 });
    expect(mocks.spend).toHaveBeenCalledOnce();
  });
  it('does not promote a subset of delayed SpendLogs', async () => {
    mocks.observed.mockResolvedValue([
      { requestId: 'a', terminalType: 'response.completed' },
      { requestId: 'b', terminalType: 'response.completed' },
    ]);
    mocks.spend.mockResolvedValue([{ requestId: 'a', rootTurnId: 'turn-1', spend: '0.1', status: 'success' }]);
    expect(await previewTurnSpend('turn-1')).toEqual({ status: 'pending', reason: 'missing_spend_log' });
  });
});
