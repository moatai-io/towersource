/**
 * Fleet customer scope policy after removal of the legacy customer_manager role.
 *
 * admin/operator can observe and troubleshoot every registered self-hosted server.
 * Other roles have no fleet access. Per-customer user mappings are retained only
 * as migration history and are no longer consulted by active authorization.
 */

export async function userCanAccessCustomer(
  _userId: number,
  role: string | null | undefined,
  _customerId: string,
): Promise<boolean> {
  return role === 'admin' || role === 'operator';
}

/** null means unrestricted; [] means no fleet visibility. */
export async function listAccessibleCustomers(
  _userId: number,
  role: string | null | undefined,
): Promise<string[] | null> {
  return role === 'admin' || role === 'operator' ? null : [];
}

export async function userCanAccessCustomerName(
  _userId: number,
  role: string | null | undefined,
  _customerName: string,
): Promise<boolean> {
  return role === 'admin' || role === 'operator';
}

/** null means unrestricted; [] means no fleet visibility. */
export async function listAccessibleCustomerNames(
  _userId: number,
  role: string | null | undefined,
): Promise<string[] | null> {
  return role === 'admin' || role === 'operator' ? null : [];
}
