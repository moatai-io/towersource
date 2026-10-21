import { describe, expect, it } from 'vitest';
import { evaluateConnectionContinuity, type ConnectionContinuityCheck } from './connection-continuity.js';
const check: ConnectionContinuityCheck = {
  projectId: 'project-a', userId: 7, connectionId: 'google-a', expectedAccess: 'allowed', access: 'allowed',
  processInjection: 'pass', providerRead: 'pass',
  diagnostics: { inventoryComplete: true, coverage: 'team-shared-and-agent-dedicated', connections: [{
    connectionId: 'google-a', displayName: 'Google', capability: 'google', status: 'unverified',
    stoppedAt: 'provider_health', reasonCode: 'ProviderAuthUnverified', summary: '', nextAction: 'test',
    stages: [{ stage: 'materialization', status: 'pass', summary: '' }],
  }] },
};
describe('connection continuity evidence', () => {
  it('fails closed without checks', () => expect(evaluateConnectionContinuity([]).complete).toBe(false));
  it('accepts verified permitted execution', () => expect(evaluateConnectionContinuity([check]).complete).toBe(true));
  it.each(['processInjection', 'providerRead'] as const)('requires %s evidence', key => {
    expect(evaluateConnectionContinuity([{ ...check, [key]: 'unknown' }]).complete).toBe(false);
    expect(evaluateConnectionContinuity([{ ...check, [key]: 'fail' }]).complete).toBe(false);
  });
  it('rejects missing diagnostics', () => expect(evaluateConnectionContinuity([{ ...check, diagnostics: undefined }]).complete).toBe(false));
  it('rejects lost access', () => expect(evaluateConnectionContinuity([{ ...check, access: 'denied' }]).complete).toBe(false));
  it('rejects expanded access', () => expect(evaluateConnectionContinuity([{ ...check, expectedAccess: 'denied' }]).complete).toBe(false));
  it('requires actual denial rather than hidden inventory', () => {
    expect(evaluateConnectionContinuity([{ ...check, expectedAccess: 'denied', access: 'unknown' }]).complete).toBe(false);
    expect(evaluateConnectionContinuity([{ ...check, expectedAccess: 'denied', access: 'denied', diagnostics: undefined }]).complete).toBe(true);
  });
});
