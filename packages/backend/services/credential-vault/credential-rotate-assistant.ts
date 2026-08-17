import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import { inferSecretPolicy, normalizeSecretInput } from './credential-input-normalizer.js';

export interface CredentialRotateTarget {
  credentialId: string;
  provider: string;
  displayName: string;
  secretName: string;
  defaultEnvName: string;
  kind: string;
  scope: string;
  metadata: Record<string, unknown>;
}

function commitment(value: string): string {
  return createHmac('sha256', config.jwtSecret).update(value).digest('hex');
}

function proposalHash(input: { actorUserId: number; credentialId: string; secretCommitment: string; expiresAt: string }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function previewCredentialRotate(input: {
  actorUserId: number;
  target: CredentialRotateTarget;
  candidate: string;
  expiresAt?: string;
}): {
  intentId: string;
  proposalHash: string;
  secretCommitment: string;
  expiresAt: string;
  impact: string;
  normalizations: string[];
  confirmationRequired: true;
} {
  const normalized = normalizeSecretInput(input.candidate, inferSecretPolicy({
    provider: input.target.provider,
    fieldId: String(input.target.metadata?.field_id ?? 'api_key'),
    envName: input.target.defaultEnvName,
    credentialType: String(input.target.metadata?.credential_type ?? input.target.kind),
  }));
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString();
  const secretCommitment = commitment(normalized.value);
  return {
    intentId: randomUUID(),
    proposalHash: proposalHash({ actorUserId: input.actorUserId, credentialId: input.target.credentialId, secretCommitment, expiresAt }),
    secretCommitment,
    expiresAt,
    impact: `${input.target.displayName}의 저장값을 교체합니다. 기존 프로젝트 연결과 Credential ID는 유지됩니다.`,
    normalizations: normalized.normalizations,
    confirmationRequired: true,
  };
}

export function verifyCredentialRotate(input: {
  actorUserId: number;
  credentialId: string;
  candidate: string;
  target: CredentialRotateTarget;
  secretCommitment: string;
  proposalHash: string;
  expiresAt: string;
  confirmed: boolean;
}): { normalizedValue: string } {
  if (input.confirmed !== true) throw Object.assign(new Error('Explicit confirmation required'), { code: 'CONFIRMATION_REQUIRED' });
  if (Date.parse(input.expiresAt) <= Date.now()) throw Object.assign(new Error('Credential rotate preview expired'), { code: 'INTENT_EXPIRED' });
  const normalized = normalizeSecretInput(input.candidate, inferSecretPolicy({
    provider: input.target.provider,
    fieldId: String(input.target.metadata?.field_id ?? 'api_key'),
    envName: input.target.defaultEnvName,
    credentialType: String(input.target.metadata?.credential_type ?? input.target.kind),
  }));
  const actualCommitment = Buffer.from(commitment(normalized.value), 'hex');
  const expectedCommitment = Buffer.from(input.secretCommitment, 'hex');
  if (actualCommitment.length !== expectedCommitment.length || !timingSafeEqual(actualCommitment, expectedCommitment)) {
    throw Object.assign(new Error('Credential value changed after preview'), { code: 'CANDIDATE_MISMATCH' });
  }
  const expectedProposal = proposalHash({ actorUserId: input.actorUserId, credentialId: input.credentialId, secretCommitment: input.secretCommitment, expiresAt: input.expiresAt });
  if (expectedProposal !== input.proposalHash) throw Object.assign(new Error('Credential rotate preview changed'), { code: 'PROPOSAL_MISMATCH' });
  return { normalizedValue: normalized.value };
}
