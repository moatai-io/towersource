/**
 * Owns: server-side validation of a Primary Agent Staffing Package's immutable Harness binding.
 * Public API: validatePrimaryAgentHarnessBinding.
 */
import { queryOne } from '../../db/pg-repo.js';

export interface PrimaryAgentCapabilityRequirements {
  required: string[];
  optional?: string[];
  forbidden?: string[];
  dataSources?: string[];
  externalActions?: string[];
  approvalConditions?: string[];
}

export interface PrimaryAgentHarnessBinding {
  harnessId: string;
  harnessVersion: number;
  runtimeProfileId: string;
  runtimeProfileVersion: number;
}

/** Validate availability, ownership and capability fit for the exact published Harness tuple. */
export async function validatePrimaryAgentHarnessBinding(input: {
  sourceProjectId: string;
  binding: PrimaryAgentHarnessBinding;
  requirements?: PrimaryAgentCapabilityRequirements;
}) {
  const { binding } = input;
  const published = await queryOne<any>(
    `SELECT h.name,h.owner_project_id,h.visibility,v.engine,v.staffing_capability_ids
       FROM harnesses h
       JOIN harness_versions v
         ON v.harness_id=h.id AND v.version=$2 AND v.status='published'
       JOIN harness_runtime_profile_versions rp
         ON rp.harness_id=v.harness_id AND rp.harness_version=v.version
        AND rp.profile_id=$3 AND rp.profile_version=$4 AND rp.status='active'
      WHERE h.id=$1 AND h.status='active'
        AND (h.visibility='system' OR h.owner_project_id=$5)`,
    [binding.harnessId, binding.harnessVersion, binding.runtimeProfileId, binding.runtimeProfileVersion, input.sourceProjectId],
  );
  if (!published) throw new Error('Published Harness binding not found or unavailable to the AI talent team Project');

  const providedCapabilities: string[] = Array.isArray(published.staffing_capability_ids)
    ? [...new Set<string>(published.staffing_capability_ids)]
    : [];
  const required = [...new Set<string>(input.requirements?.required || [])];
  const forbidden = [...new Set<string>(input.requirements?.forbidden || [])];
  const missingRequired = required.filter((id) => !providedCapabilities.includes(id));
  const forbiddenPresent = forbidden.filter((id) => providedCapabilities.includes(id));
  if (missingRequired.length || forbiddenPresent.length) {
    const error = new Error('Harness capability mismatch') as Error & { details?: unknown };
    error.details = { missingRequired, forbiddenPresent };
    throw error;
  }

  return {
    harnessName: published.name as string,
    engine: published.engine as 'pi' | 'claude',
    providedCapabilities,
    requiredCapabilities: required,
    missingRequired,
    forbiddenPresent,
  };
}
