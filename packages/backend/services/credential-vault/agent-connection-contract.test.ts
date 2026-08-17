import { describe, expect, it } from 'vitest';
import { deriveConnectionReadiness } from './connection-read-model.js';
import { diagnoseConnection, requireReady, resolveCapability, type AgentConnectionRecord } from './agent-connection-contract.js';

function record(overrides: Partial<AgentConnectionRecord> = {}): AgentConnectionRecord {
  return {
    connectionId: 'provider:higgsfield:company-video',
    displayName: 'Higgsfield · 회사 영상 제작',
    provider: 'higgsfield',
    capabilities: ['video_generation', 'image_generation'],
    readiness: deriveConnectionReadiness({
      enabled: true,
      existingStatus: 'connected',
      connectedProjectCount: 1,
      blockedProjectCount: 0,
      attentionProjectCount: 0,
    }),
    configurationStatus: 'complete',
    ...overrides,
  };
}

describe('agent Connection contract', () => {
  it('does not allow use when a Connection is granted but Provider health is unknown', () => {
    expect(diagnoseConnection(record())).toMatchObject({
      canUseNow: false,
      effectiveStatus: 'connected_unverified',
      reasonCode: 'ProbeUnsupported',
      recommendedAction: { type: 'test' },
    });
  });

  it('allows use only after explicit Provider readiness evidence', () => {
    const readyRecord = record({
      readiness: deriveConnectionReadiness({
        enabled: true,
        existingStatus: 'connected',
        connectedProjectCount: 1,
        blockedProjectCount: 0,
        attentionProjectCount: 0,
        providerHealth: { status: 'ready' },
      }),
    });
    expect(requireReady([readyRecord], 'video_generation')).toMatchObject({
      ready: true,
      selected: { canUseNow: true, reasonCode: 'Ready' },
    });
  });

  it('returns one actionable repair instead of exposing Provider credential details', () => {
    const expired = diagnoseConnection(record({
      readiness: deriveConnectionReadiness({
        enabled: true,
        existingStatus: 'connected',
        connectedProjectCount: 1,
        blockedProjectCount: 0,
        attentionProjectCount: 0,
        providerHealth: { status: 'reauth_required' },
      }),
    }));
    expect(expired).toMatchObject({
      reasonCode: 'ReauthRequired',
      recommendedAction: { type: 'reauth', requiresUserInteraction: true },
    });
    const serialized = JSON.stringify(expired).toLowerCase();
    for (const forbidden of ['secret', 'token', 'envname', 'filepath', 'credentials_blob', 'api_key_secret']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('prefers a ready alternative for the requested capability', () => {
    const unknown = record();
    const ready = record({
      connectionId: 'provider:other:video',
      displayName: '대체 영상 연결',
      provider: 'other',
      readiness: deriveConnectionReadiness({
        enabled: true,
        existingStatus: 'connected',
        connectedProjectCount: 1,
        blockedProjectCount: 0,
        attentionProjectCount: 0,
        providerHealth: { status: 'ready' },
      }),
    });
    expect(resolveCapability([unknown, ready], 'video_generation').selected?.connectionId).toBe('provider:other:video');
  });

  it('does not guess a Provider when no Connection offers the capability', () => {
    expect(resolveCapability([record()], 'document_signing')).toEqual({
      capability: 'document_signing',
      ready: false,
      selected: null,
      alternatives: [],
      reasonCode: 'MissingConfiguration',
    });
  });

  it('distinguishes materialization failure from Provider authentication failure', () => {
    const view = diagnoseConnection(record({
      readiness: deriveConnectionReadiness({
        enabled: true,
        existingStatus: 'connected',
        connectedProjectCount: 1,
        blockedProjectCount: 0,
        attentionProjectCount: 0,
        materializationFailed: true,
        providerHealth: { status: 'ready' },
      }),
    }));
    expect(view).toMatchObject({ canUseNow: false, reasonCode: 'MaterializationFailed', recommendedAction: { type: 'inspect' } });
  });
});
