/** Owns immutable Service Agent identity snapshots and their system-prompt projection. */
import { queryOne } from '../../db/pg-repo.js';

export interface ServiceIdentitySnapshot {
  displayName: string;
  role: string;
  promise: string;
  instruction: string;
  face?: string;
  sourceAgentProjectId?: string;
  sourceAgentProfileVersion?: number;
}

function text(value: unknown, label: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`Service identity ${label} required`);
  if (normalized.length > max) throw new Error(`Service identity ${label} exceeds ${max} characters`);
  return normalized;
}

export function normalizeServiceIdentity(value: unknown): ServiceIdentitySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Service identity snapshot required');
  const row = value as Record<string, unknown>;
  const snapshot: ServiceIdentitySnapshot = {
    displayName: text(row.displayName, 'displayName', 120),
    role: text(row.role, 'role', 1000),
    promise: text(row.promise, 'promise', 1000),
    instruction: text(row.instruction, 'instruction', 12000),
  };
  if (typeof row.face === 'string' && row.face.trim() && row.face.length <= 120) snapshot.face = row.face.trim();
  if (typeof row.sourceAgentProjectId === 'string' && row.sourceAgentProjectId.trim()) snapshot.sourceAgentProjectId = row.sourceAgentProjectId.trim();
  if (row.sourceAgentProfileVersion !== undefined) {
    const version = Number(row.sourceAgentProfileVersion);
    if (!Number.isInteger(version) || version < 0) throw new Error('Service identity sourceAgentProfileVersion must be a non-negative integer');
    snapshot.sourceAgentProfileVersion = version;
  }
  return snapshot;
}

/** Fill a missing identity from the current source Agent profile, copying behavior only—not authority or memory. */
export async function canonicalizeServiceExperienceSnapshot(serviceId: string, value: unknown): Promise<Record<string, unknown>> {
  const experience = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (experience.identity !== undefined) return { ...experience, identity: normalizeServiceIdentity(experience.identity) };
  const source = await queryOne<{
    service_name: string; service_description: string; owner_project_id: string;
    display_name: string | null; face: string | null; role: string | null; promise: string | null; instruction: string | null; instruction_version: number | null;
  }>(
    `SELECT s.name AS service_name,s.description AS service_description,s.owner_project_id,
            pap.display_name,pap.face,pap.role,pap.promise,pap.instruction,pap.instruction_version
       FROM ai_services s LEFT JOIN project_agent_profiles pap ON pap.project_id=s.owner_project_id
      WHERE s.id=$1`,
    [serviceId],
  );
  if (!source) throw new Error('AI service not found');
  return {
    ...experience,
    identity: normalizeServiceIdentity({
      displayName: source.service_name,
      role: source.role || source.service_description || 'AI service assistant',
      promise: source.promise || 'Serve the approved audience within the deployed policy.',
      instruction: source.instruction || source.service_description || 'Answer only within the approved Service scope.',
      face: source.face || undefined,
      sourceAgentProjectId: source.owner_project_id,
      sourceAgentProfileVersion: Number(source.instruction_version || 0),
    }),
  };
}

export function serviceIdentityFromExperience(value: unknown): ServiceIdentitySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Service experience snapshot required');
  return normalizeServiceIdentity((value as Record<string, unknown>).identity);
}

export function buildServiceAgentRuntimePrompt(identity: ServiceIdentitySnapshot): string {
  return [
    '## AI Service Agent',
    '',
    `You are **${identity.displayName}**, a separate deployed Service Agent.`,
    `Role: ${identity.role}`,
    `Promise: ${identity.promise}`,
    '',
    identity.instruction,
    '',
    'This immutable Service identity is behavior-only. Do not inherit the source Project Agent identity, private memory, Sessions, credentials, filesystem authority, or tools.',
  ].join('\n');
}
