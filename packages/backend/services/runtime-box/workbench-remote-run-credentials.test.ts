import { describe, expect, it } from 'vitest';
import {
  consumeRemoteRunCredentialEnvelope,
  discardRemoteRunCredentialEnvelope,
  issueRemoteRunCredentialEnvelope,
  remoteRunCredentialEnvelopeCount,
} from './workbench-remote-run-credentials.js';

describe('Remote Worker run-scoped Credential envelope', () => {
  it('returns only safe metadata and permits one matching consumption', () => {
    const envelope = issueRemoteRunCredentialEnvelope({
      jobId: 41, projectId: 'project-a', values: { FAKE_REMOTE_TOKEN: 'fake-secret-value' }, now: 1_000, ttlMs: 5_000,
    });
    expect(envelope).toMatchObject({ jobId: 41, projectId: 'project-a', environmentKeys: ['FAKE_REMOTE_TOKEN'] });
    expect(JSON.stringify(envelope)).not.toContain('fake-secret-value');
    expect(consumeRemoteRunCredentialEnvelope({ envelopeId: envelope.envelopeId, jobId: 41, projectId: 'project-a', now: 2_000 }))
      .toEqual({ FAKE_REMOTE_TOKEN: 'fake-secret-value' });
    expect(() => consumeRemoteRunCredentialEnvelope({ envelopeId: envelope.envelopeId, jobId: 41, projectId: 'project-a', now: 2_001 }))
      .toThrow('REMOTE_RUN_CREDENTIAL_UNAVAILABLE');
  });

  it('does not consume on Project or Job mismatch', () => {
    const envelope = issueRemoteRunCredentialEnvelope({ jobId: 42, projectId: 'project-a', values: { FAKE_REMOTE_TOKEN: 'hidden' } });
    expect(() => consumeRemoteRunCredentialEnvelope({ envelopeId: envelope.envelopeId, jobId: 43, projectId: 'project-a' }))
      .toThrow('REMOTE_RUN_CREDENTIAL_SCOPE_MISMATCH');
    expect(() => consumeRemoteRunCredentialEnvelope({ envelopeId: envelope.envelopeId, jobId: 42, projectId: 'project-b' }))
      .toThrow('REMOTE_RUN_CREDENTIAL_SCOPE_MISMATCH');
    expect(consumeRemoteRunCredentialEnvelope({ envelopeId: envelope.envelopeId, jobId: 42, projectId: 'project-a' }))
      .toEqual({ FAKE_REMOTE_TOKEN: 'hidden' });
  });

  it('discards an unconsumed envelope without exposing its contents', () => {
    const envelope = issueRemoteRunCredentialEnvelope({ jobId: 45, projectId: 'project-a', values: { API_TOKEN: 'hidden' } });
    expect(discardRemoteRunCredentialEnvelope(envelope.envelopeId)).toBe(true);
    expect(() => consumeRemoteRunCredentialEnvelope({ envelopeId: envelope.envelopeId, jobId: 45, projectId: 'project-a' }))
      .toThrow('REMOTE_RUN_CREDENTIAL_UNAVAILABLE');
  });

  it('expires envelopes and validates environment names without exposing values', () => {
    const envelope = issueRemoteRunCredentialEnvelope({ jobId: 44, projectId: 'project-a', values: { FAKE_REMOTE_TOKEN: 'hidden' }, now: 1_000, ttlMs: 1_000 });
    expect(() => consumeRemoteRunCredentialEnvelope({ envelopeId: envelope.envelopeId, jobId: 44, projectId: 'project-a', now: 2_001 }))
      .toThrow('REMOTE_RUN_CREDENTIAL_UNAVAILABLE');
    expect(() => issueRemoteRunCredentialEnvelope({ jobId: 1, projectId: 'p', values: { 'bad-name': 'hidden' } }))
      .toThrow('REMOTE_RUN_CREDENTIAL_ENV_INVALID');
    expect(remoteRunCredentialEnvelopeCount()).toBe(0);
  });
});
