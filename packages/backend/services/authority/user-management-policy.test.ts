import { describe, expect, it } from 'vitest';
import { canManageUserRole } from './user-management-policy.js';
describe('company user management boundary', () => {
  it.each(['member', 'viewer', 'guest'])('lets operators manage ordinary %s accounts', role => {
    expect(canManageUserRole('operator', role, 'member')).toBe(true);
    expect(canManageUserRole('operator', undefined, role)).toBe(true);
  });
  it.each(['operator', 'admin', 'unknown'])('protects %s targets and elevations', role => {
    expect(canManageUserRole('operator', role)).toBe(false);
    expect(canManageUserRole('operator', 'member', role)).toBe(false);
  });
  it('preserves platform administration but rejects non-administrators', () => {
    expect(canManageUserRole('admin', 'operator', 'admin')).toBe(true);
    expect(canManageUserRole('member', 'member')).toBe(false);
  });
});
