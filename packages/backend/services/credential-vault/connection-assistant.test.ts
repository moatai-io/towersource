import { describe, expect, it } from 'vitest';
import { connectionManifest, previewConnectionChange, verifyConnectionChange } from './connection-assistant.js';

const base = {
  actorUserId: 7,
  connectionId: 'profile:higgsfield-main',
  connectionDisplayName: 'Higgsfield — 회사 영상 제작',
  source: 'profile' as const,
  sourceId: 'higgsfield-main',
  projectId: 'project-a',
  projectName: '영상 프로젝트',
  provider: 'higgsfield',
  riskLevel: 'medium' as const,
  action: 'connect' as const,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('Connection Assistant contract', () => {
  it('describes provider capabilities without exposing credential structure', () => {
    expect(connectionManifest('higgsfield')).toEqual(expect.objectContaining({
      provider: 'higgsfield',
      capabilities: ['video_generation'],
      authMethods: expect.arrayContaining([
        expect.objectContaining({ id: 'cli_oauth', probe: 'safe' }),
        expect.objectContaining({ id: 'cloud_api', probe: 'unsupported' }),
      ]),
    }));
  });

  it('creates a secret-free exact preview', () => {
    const preview = previewConnectionChange(base);
    expect(preview.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview).toMatchObject({ action: 'connect', confirmationRequired: true, project: { id: 'project-a' } });
    const serialized = JSON.stringify(preview);
    for (const forbidden of ['secretEnvNames', 'envName', 'token', 'api_key_secret', 'filePath']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('rejects unconfirmed, changed, and expired apply attempts', () => {
    const preview = previewConnectionChange(base);
    expect(() => verifyConnectionChange({ ...base, proposalHash: preview.proposalHash, confirmed: false })).toThrow('Explicit confirmation');
    expect(() => verifyConnectionChange({ ...base, projectId: 'project-b', proposalHash: preview.proposalHash, confirmed: true })).toThrow('changed');
    expect(() => verifyConnectionChange({ ...base, expiresAt: '2020-01-01T00:00:00.000Z', proposalHash: preview.proposalHash, confirmed: true })).toThrow('expired');
  });

  it('maps approved connect and disconnect to the existing policy model', () => {
    const connect = previewConnectionChange(base);
    expect(verifyConnectionChange({ ...base, proposalHash: connect.proposalHash, confirmed: true }).mode).toBe('allow');
    const disconnectInput = { ...base, action: 'disconnect' as const };
    const disconnect = previewConnectionChange(disconnectInput);
    expect(verifyConnectionChange({ ...disconnectInput, proposalHash: disconnect.proposalHash, confirmed: true }).mode).toBe('deny');
  });
});
