import { describe, expect, it } from 'vitest';
import { accessiblePathsFallbackForRole } from './ws-access-policy.js';

describe('accessiblePathsFallbackForRole', () => {
  it.each(['member', 'viewer', 'guest', undefined, null])(
    'fails closed for non-privileged role %s',
    (role) => {
      expect(accessiblePathsFallbackForRole(role)).toEqual([]);
    },
  );

  it.each(['admin', 'operator', 'customer_manager'])(
    'preserves privileged fallback for %s',
    (role) => {
      expect(accessiblePathsFallbackForRole(role)).toBeNull();
    },
  );
});
