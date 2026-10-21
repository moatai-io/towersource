import { describe, expect, it } from 'vitest';
import { deriveConnectionReadiness } from './connection-read-model.js';

const connected = {
  enabled: true,
  existingStatus: 'connected' as const,
  connectedProjectCount: 1,
  blockedProjectCount: 0,
  attentionProjectCount: 0,
};

describe('deriveConnectionReadiness', () => {
  it('does not call a project-granted connection ready without Provider evidence', () => {
    expect(deriveConnectionReadiness(connected)).toMatchObject({
      effectiveStatus: 'connected_unverified',
      access: { status: 'connected' },
      providerHealth: { status: 'unknown', action: 'test' },
    });
  });

  it('marks a connection ready only with explicit Provider health evidence', () => {
    expect(deriveConnectionReadiness({
      ...connected,
      lastMaterializedAt: '2026-08-01T12:00:00.000Z',
      providerHealth: { status: 'ready', checkedAt: '2026-08-01T12:01:00.000Z' },
    })).toMatchObject({
      effectiveStatus: 'ready',
      materialization: { status: 'verified' },
      providerHealth: { status: 'ready', action: 'none' },
    });
  });

  it.each([
    ['invalid', 'rotate'],
    ['reauth_required', 'reauth'],
    ['degraded', 'inspect'],
  ] as const)('maps %s Provider state to attention and a recovery action', (status, action) => {
    expect(deriveConnectionReadiness({ ...connected, providerHealth: { status } })).toMatchObject({
      effectiveStatus: 'needs_attention',
      providerHealth: { status, action },
    });
  });

  it('preserves existing profile and target warnings ahead of Provider state', () => {
    expect(deriveConnectionReadiness({
      ...connected,
      existingStatus: 'needs_attention',
      providerHealth: { status: 'ready' },
    }).effectiveStatus).toBe('needs_attention');
  });

  it('keeps ungranted and disabled connections distinct', () => {
    expect(deriveConnectionReadiness({ ...connected, connectedProjectCount: 0 }).effectiveStatus).toBe('off');
    expect(deriveConnectionReadiness({ ...connected, enabled: false }).effectiveStatus).toBe('disabled');
  });
});

it('never lets old provider success override failed or unverified materialization', () => {
  expect(deriveConnectionReadiness({ ...connected, materializationFailed: true, providerHealth: { status: 'ready' } }).effectiveStatus).toBe('needs_attention');
  expect(deriveConnectionReadiness({ ...connected, providerHealth: { status: 'ready' } }).effectiveStatus).toBe('connected_unverified');
});
