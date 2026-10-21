import { describe, expect, it } from 'vitest';
import {
  listAccessibleCustomerNames,
  listAccessibleCustomers,
  userCanAccessCustomer,
  userCanAccessCustomerName,
} from './customer-scope.js';

describe('fleet customer scope after customer_manager removal', () => {
  it.each(['admin', 'operator'])('%s can access every customer', async (role) => {
    await expect(userCanAccessCustomer(8, role, 'demo-org')).resolves.toBe(true);
    await expect(userCanAccessCustomerName(8, role, 'demo-org')).resolves.toBe(true);
    await expect(listAccessibleCustomers(8, role)).resolves.toBeNull();
    await expect(listAccessibleCustomerNames(8, role)).resolves.toBeNull();
  });

  it.each(['member', 'viewer', 'guest', 'customer_manager', undefined, null])(
    'non-operational legacy/ordinary role %s has no fleet access',
    async (role) => {
      await expect(userCanAccessCustomer(8, role, 'demo-org')).resolves.toBe(false);
      await expect(userCanAccessCustomerName(8, role, 'demo-org')).resolves.toBe(false);
      await expect(listAccessibleCustomers(8, role)).resolves.toEqual([]);
      await expect(listAccessibleCustomerNames(8, role)).resolves.toEqual([]);
    },
  );
});
