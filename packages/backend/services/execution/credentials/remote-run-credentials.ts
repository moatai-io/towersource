/**
 * Owns: in-memory, single-consumption Credential envelopes for Remote Worker Jobs.
 * Public API: issueRemoteRunCredentialEnvelope, consumeRemoteRunCredentialEnvelope.
 *
 * Values remain Tower-process-memory-only until one matching dispatch consumes them.
 * The caller must deliver consumed values only over an authenticated Worker transport;
 * metadata is safe to persist, but values must never enter Job rows or workspace files.
 */

import { randomUUID } from 'node:crypto';

export interface RemoteRunCredentialEnvelope {
  envelopeId: string;
  jobId: number;
  projectId: string;
  expiresAt: string;
  environmentKeys: string[];
}

interface StoredEnvelope extends RemoteRunCredentialEnvelope {
  values: Record<string, string>;
  consumed: boolean;
}

const envelopes = new Map<string, StoredEnvelope>();
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function purgeExpired(now = Date.now()): void {
  for (const [id, envelope] of envelopes) {
    if (Date.parse(envelope.expiresAt) <= now || envelope.consumed) envelopes.delete(id);
  }
}

/** Issue metadata that is safe to persist; values remain process-memory-only. */
export function issueRemoteRunCredentialEnvelope(input: {
  jobId: number;
  projectId: string;
  values: Record<string, string>;
  ttlMs?: number;
  now?: number;
}): RemoteRunCredentialEnvelope {
  purgeExpired(input.now);
  const keys = Object.keys(input.values).sort();
  if (keys.length === 0) throw new Error('REMOTE_RUN_CREDENTIAL_EMPTY');
  if (keys.some(key => !SAFE_ENV_NAME.test(key))) throw new Error('REMOTE_RUN_CREDENTIAL_ENV_INVALID');
  if (Object.values(input.values).some(value => !value)) throw new Error('REMOTE_RUN_CREDENTIAL_VALUE_EMPTY');
  const ttlMs = Math.min(Math.max(input.ttlMs ?? 30_000, 1_000), 60_000);
  const envelopeId = randomUUID();
  const envelope: StoredEnvelope = {
    envelopeId,
    jobId: input.jobId,
    projectId: input.projectId,
    expiresAt: new Date((input.now ?? Date.now()) + ttlMs).toISOString(),
    environmentKeys: keys,
    values: { ...input.values },
    consumed: false,
  };
  envelopes.set(envelopeId, envelope);
  return {
    envelopeId: envelope.envelopeId,
    jobId: envelope.jobId,
    projectId: envelope.projectId,
    expiresAt: envelope.expiresAt,
    environmentKeys: [...envelope.environmentKeys],
  };
}

/** Consume exactly once after matching Worker-authenticated Job and Project identity. */
export function consumeRemoteRunCredentialEnvelope(input: {
  envelopeId: string;
  jobId: number;
  projectId: string;
  now?: number;
}): Record<string, string> {
  const now = input.now ?? Date.now();
  purgeExpired(now);
  const envelope = envelopes.get(input.envelopeId);
  if (!envelope) throw new Error('REMOTE_RUN_CREDENTIAL_UNAVAILABLE');
  if (envelope.jobId !== input.jobId || envelope.projectId !== input.projectId) {
    throw new Error('REMOTE_RUN_CREDENTIAL_SCOPE_MISMATCH');
  }
  if (Date.parse(envelope.expiresAt) <= now) {
    envelopes.delete(input.envelopeId);
    throw new Error('REMOTE_RUN_CREDENTIAL_EXPIRED');
  }
  envelope.consumed = true;
  envelopes.delete(input.envelopeId);
  return { ...envelope.values };
}

/** Drop an unconsumed envelope on cancellation, setup failure, or dispatch failure. */
export function discardRemoteRunCredentialEnvelope(envelopeId: string): boolean {
  return envelopes.delete(envelopeId);
}

/** Test-only visibility that returns count, never ids, names, or values. */
export function remoteRunCredentialEnvelopeCount(): number {
  purgeExpired();
  return envelopes.size;
}
