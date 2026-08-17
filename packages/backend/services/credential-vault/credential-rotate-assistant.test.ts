import { describe, expect, it } from 'vitest';
import { previewCredentialRotate, verifyCredentialRotate } from './credential-rotate-assistant.js';

const target = {
  credentialId: 'openai-api-key', provider: 'openai', displayName: 'OpenAI API key', secretName: 'OPENAI_API_KEY',
  defaultEnvName: 'OPENAI_API_KEY', kind: 'api_key', scope: 'workspace', metadata: {},
};

describe('credential rotate assistant', () => {
  it('returns a secret-free preview and preserves identity in its impact', () => {
    const preview = previewCredentialRotate({ actorUserId: 7, target, candidate: '  Bearer abcdefghijklmnop  ', expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(preview.impact).toContain('기존 프로젝트 연결과 Credential ID는 유지');
    expect(preview.normalizations).toEqual(expect.arrayContaining(['removed_outer_whitespace', 'removed_authorization_scheme']));
    expect(JSON.stringify(preview)).not.toContain('abcdefghijklmnop');
  });

  it('requires the same candidate at apply time', () => {
    const preview = previewCredentialRotate({ actorUserId: 7, target, candidate: 'abcdefghijklmnop', expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(verifyCredentialRotate({ actorUserId: 7, credentialId: target.credentialId, target, candidate: 'abcdefghijklmnop', secretCommitment: preview.secretCommitment, proposalHash: preview.proposalHash, expiresAt: preview.expiresAt, confirmed: true })).toEqual({ normalizedValue: 'abcdefghijklmnop' });
    expect(() => verifyCredentialRotate({ actorUserId: 7, credentialId: target.credentialId, target, candidate: 'different-candidate', secretCommitment: preview.secretCommitment, proposalHash: preview.proposalHash, expiresAt: preview.expiresAt, confirmed: true })).toThrow('Credential value changed after preview');
  });
});
