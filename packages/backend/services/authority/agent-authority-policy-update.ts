/** Ordinary staffing/profile editing never assigns the platform execution switch.
 * Only superuser currently drives native host execution; unrelated policy keys
 * remain editable. Dedicated admin platform settings own activation/deactivation.
 */
export function preserveAgentExecutionAuthority(
  current: Record<string, unknown>,
  requested?: Record<string, unknown>,
): Record<string, unknown> {
  if (requested === undefined) return current;
  if (Object.prototype.hasOwnProperty.call(requested, 'superuser')) {
    const value = requested.superuser;
    if (typeof value !== 'boolean' || value !== (current.superuser === true)) {
      throw new Error('AGENT_EXECUTION_AUTHORITY_RESERVED: superuser requires dedicated platform administration');
    }
  }
  const { superuser: _ignored, ...editable } = requested;
  return Object.prototype.hasOwnProperty.call(current, 'superuser')
    ? { ...editable, superuser: current.superuser }
    : editable;
}

/** Staffing approval is not platform approval. Validate without altering its hash. */
export function assertOrdinaryAgentCreationAuthority(policy?: Record<string, unknown>): void {
  preserveAgentExecutionAuthority({}, policy);
}
