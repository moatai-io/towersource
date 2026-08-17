/**
 * Owns: deterministic preview/verification helpers for Credential Vault rotation confirmations.
 * Public API: previewCredentialRotation, verifyCredentialRotation. Keep secret values out of inputs.
 */
import { createHash, randomUUID } from 'node:crypto';

export interface CredentialRotationPreviewInput {
  actorUserId: number;
  credentialId: string;
  displayName: string;
  provider: string;
  credentialType: string;
  affectedProjectCount: number;
  expiresAt?: string;
}

function canonical(input: CredentialRotationPreviewInput, expiresAt: string) {
  return {
    actorUserId: input.actorUserId,
    credentialId: input.credentialId,
    provider: input.provider,
    credentialType: input.credentialType,
    affectedProjectCount: input.affectedProjectCount,
    expiresAt,
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Builds a redacted rotation preview and stable proposal hash without touching secret values. */
export function previewCredentialRotation(input: CredentialRotationPreviewInput) {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    intentId: randomUUID(),
    proposalHash: digest(canonical(input, expiresAt)),
    expiresAt,
    credential: { id: input.credentialId, displayName: input.displayName, provider: input.provider, credentialType: input.credentialType },
    impact: `저장된 ${input.displayName} 값을 교체합니다. 기존 ${input.affectedProjectCount}개 프로젝트 연결과 Credential ID는 유지됩니다.`,
    affectedProjectCount: input.affectedProjectCount,
    confirmationRequired: true as const,
  };
}

/** Verifies the user-approved preview hash and expiry before allowing a credential rotation. */
export function verifyCredentialRotation(input: CredentialRotationPreviewInput & { proposalHash: string; confirmed: boolean }) {
  if (input.confirmed !== true) throw Object.assign(new Error('Explicit confirmation required'), { code: 'CONFIRMATION_REQUIRED' });
  if (!input.expiresAt || Date.parse(input.expiresAt) <= Date.now()) throw Object.assign(new Error('Credential rotation preview expired'), { code: 'INTENT_EXPIRED' });
  if (digest(canonical(input, input.expiresAt)) !== input.proposalHash) throw Object.assign(new Error('Credential rotation preview changed'), { code: 'PROPOSAL_MISMATCH' });
  return { ok: true as const };
}
