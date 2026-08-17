import { describe, expect, it } from 'vitest';
import { previewCredentialRotation, verifyCredentialRotation, type CredentialRotationPreviewInput } from './credential-rotation-assistant.js';

const baseInput: CredentialRotationPreviewInput = {
  actorUserId: 42,
  credentialId: 'cred-openai-main',
  displayName: 'OpenAI API Key',
  provider: 'openai',
  credentialType: 'api-key',
  affectedProjectCount: 3,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('credential-rotation-assistant', () => {
  it('creates a redacted preview that can be verified by hash', () => {
    const preview = previewCredentialRotation(baseInput);

    expect(preview.intentId).toBeTruthy();
    expect(preview.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.credential).toEqual({
      id: 'cred-openai-main',
      displayName: 'OpenAI API Key',
      provider: 'openai',
      credentialType: 'api-key',
    });
    expect(JSON.stringify(preview)).not.toContain('secret');

    expect(verifyCredentialRotation({
      ...baseInput,
      proposalHash: preview.proposalHash,
      confirmed: true,
    })).toEqual({ ok: true });
  });

  it('rejects unconfirmed, expired, or changed previews', () => {
    const preview = previewCredentialRotation(baseInput);

    expect(() => verifyCredentialRotation({
      ...baseInput,
      proposalHash: preview.proposalHash,
      confirmed: false,
    })).toThrow(/Explicit confirmation required/);

    expect(() => verifyCredentialRotation({
      ...baseInput,
      expiresAt: '2000-01-01T00:00:00.000Z',
      proposalHash: preview.proposalHash,
      confirmed: true,
    })).toThrow(/expired/);

    expect(() => verifyCredentialRotation({
      ...baseInput,
      affectedProjectCount: 4,
      proposalHash: preview.proposalHash,
      confirmed: true,
    })).toThrow(/changed/);
  });
});
