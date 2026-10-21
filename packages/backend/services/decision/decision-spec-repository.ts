import { createHash } from 'node:crypto';
import { execute, query, queryOne } from '../../db/pg-repo.js';
import { parseDecisionSpec, type DecisionSpec } from './decision-spec.js';

export type DecisionPrincipal = { type: 'project'; id: string } | { type: 'agent'; id: string };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function decisionSpecHash(spec: DecisionSpec): string { return createHash('sha256').update(stable(spec)).digest('hex'); }

export async function publishDecisionSpec(input: { spec: unknown; userId?: number }): Promise<DecisionSpec> {
  const spec = parseDecisionSpec(input.spec);
  await execute(`INSERT INTO decision_spec_versions(spec_id,revision,schema_version,spec,spec_hash,published_by_user_id)
    VALUES($1,$2,$3,$4::jsonb,$5,$6)`, [spec.id, spec.revision, spec.schemaVersion, JSON.stringify(spec), decisionSpecHash(spec), input.userId ?? null]);
  return spec;
}

export async function bindDecisionSpec(input: { projectId: string; principal: DecisionPrincipal; specId: string; specRevision: number; userId?: number }): Promise<void> {
  if (input.principal.type === 'project' && input.principal.id !== input.projectId) throw new Error('DECISION_BINDING_PROJECT_ID_MISMATCH');
  await execute(`INSERT INTO decision_spec_bindings(project_id,principal_type,principal_id,spec_id,spec_revision,bound_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [input.projectId, input.principal.type, input.principal.id, input.specId, input.specRevision, input.userId ?? null]);
}

export async function requireBoundDecisionSpec(input: { projectId: string; principal: DecisionPrincipal; specId: string; specRevision?: number }): Promise<DecisionSpec> {
  const row = await queryOne<{ spec: unknown }>(`SELECT v.spec FROM decision_spec_bindings b
    JOIN decision_spec_versions v ON v.spec_id=b.spec_id AND v.revision=b.spec_revision
    WHERE b.project_id=$1 AND b.principal_type=$2 AND b.principal_id=$3 AND b.spec_id=$4 AND b.state='active'
      AND ($5::integer IS NULL OR b.spec_revision=$5)
    ORDER BY b.spec_revision DESC LIMIT 1`, [input.projectId, input.principal.type, input.principal.id, input.specId, input.specRevision ?? null]);
  if (!row) throw new Error('DECISION_SPEC_ACCESS_DENIED');
  return parseDecisionSpec(row.spec);
}

export async function listBoundDecisionSpecs(input: { projectId: string; principal: DecisionPrincipal }): Promise<DecisionSpec[]> {
  const rows = await query<{ spec: unknown }>(`SELECT v.spec FROM decision_spec_bindings b
    JOIN decision_spec_versions v ON v.spec_id=b.spec_id AND v.revision=b.spec_revision
    WHERE b.project_id=$1 AND b.principal_type=$2 AND b.principal_id=$3 AND b.state='active'
    ORDER BY b.spec_id,b.spec_revision`, [input.projectId, input.principal.type, input.principal.id]);
  return rows.map((row) => parseDecisionSpec(row.spec));
}
