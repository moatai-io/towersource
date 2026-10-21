export interface LegacyCustomerMappingRetirementFacts {
  tableExists: boolean;
  migration191AppliedAt: string | null;
  legacyUserRoleCount: number;
  legacyInviteRoleCount: number;
  mappingRowCount: number;
  activeSourceReferences: string[];
  compatibilityReleaseConfirmed: boolean;
  mappingArchiveConfirmed: boolean;
}

export interface LegacyCustomerMappingRetirementReport extends LegacyCustomerMappingRetirementFacts {
  ready: boolean;
  blockers: string[];
  nextAction: 'no_table' | 'wait_for_191' | 'resolve_blockers' | 'prepare_drop_migration';
}

/** Pure, fail-closed retirement decision. This function never reads or mutates the database. */
export function evaluateLegacyCustomerMappingRetirement(
  facts: LegacyCustomerMappingRetirementFacts,
): LegacyCustomerMappingRetirementReport {
  if (!facts.tableExists) return { ...facts, ready: true, blockers: [], nextAction: 'no_table' };
  const blockers: string[] = [];
  if (!facts.migration191AppliedAt) blockers.push('migration 191 has not been applied');
  if (facts.legacyUserRoleCount > 0) blockers.push(`${facts.legacyUserRoleCount} users still have customer_manager role`);
  if (facts.legacyInviteRoleCount > 0) blockers.push(`${facts.legacyInviteRoleCount} invite defaults still use customer_manager role`);
  if (facts.activeSourceReferences.length > 0) blockers.push(`active source still references the table: ${facts.activeSourceReferences.join(', ')}`);
  if (!facts.compatibilityReleaseConfirmed) blockers.push('one post-191 compatibility release has not been explicitly confirmed');
  if (facts.mappingRowCount > 0 && !facts.mappingArchiveConfirmed) blockers.push(`${facts.mappingRowCount} legacy mappings remain without archive/retention confirmation`);
  return {
    ...facts,
    ready: blockers.length === 0,
    blockers,
    nextAction: !facts.migration191AppliedAt ? 'wait_for_191' : blockers.length > 0 ? 'resolve_blockers' : 'prepare_drop_migration',
  };
}
