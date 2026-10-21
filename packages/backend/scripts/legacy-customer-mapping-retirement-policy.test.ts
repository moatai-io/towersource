import { describe, expect, it } from 'vitest';
import { evaluateLegacyCustomerMappingRetirement } from './legacy-customer-mapping-retirement-policy.js';

const safe = {
  tableExists: true,
  migration191AppliedAt: '2026-08-27T00:00:00.000Z',
  legacyUserRoleCount: 0,
  legacyInviteRoleCount: 0,
  mappingRowCount: 0,
  activeSourceReferences: [],
  compatibilityReleaseConfirmed: true,
  mappingArchiveConfirmed: false,
};

describe('legacy customer mapping retirement policy', () => {
  it('is ready only after 191, source detachment, and explicit release confirmation', () => {
    expect(evaluateLegacyCustomerMappingRetirement(safe)).toMatchObject({ ready: true, blockers: [], nextAction: 'prepare_drop_migration' });
  });

  it('fails closed before the compatibility release is confirmed', () => {
    const result = evaluateLegacyCustomerMappingRetirement({ ...safe, compatibilityReleaseConfirmed: false });
    expect(result).toMatchObject({ ready: false, nextAction: 'resolve_blockers' });
    expect(result.blockers).toContain('one post-191 compatibility release has not been explicitly confirmed');
  });

  it('requires archive or retention confirmation when legacy mappings remain', () => {
    const result = evaluateLegacyCustomerMappingRetirement({ ...safe, mappingRowCount: 4 });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('4 legacy mappings remain without archive/retention confirmation');
    expect(evaluateLegacyCustomerMappingRetirement({ ...safe, mappingRowCount: 4, mappingArchiveConfirmed: true }).ready).toBe(true);
  });

  it('blocks stale roles, invites, and active source references', () => {
    const result = evaluateLegacyCustomerMappingRetirement({
      ...safe,
      legacyUserRoleCount: 1,
      legacyInviteRoleCount: 2,
      activeSourceReferences: ['packages/backend/routes/example.ts'],
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      '1 users still have customer_manager role',
      '2 invite defaults still use customer_manager role',
      'active source still references the table: packages/backend/routes/example.ts',
    ]));
  });

  it('reports an already absent table as a no-op success', () => {
    expect(evaluateLegacyCustomerMappingRetirement({ ...safe, tableExists: false })).toMatchObject({ ready: true, nextAction: 'no_table' });
  });
});
