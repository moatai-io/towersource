/** Retired internal API: team membership replaces the unactivated organization
 * allowlist. Fail closed for stale callers; never read or mutate old settings.
 * Remove this tombstone with its tests when the owning change is committed.
 */
export async function setOrganizationExecutionAdmission(_input: { actorUserId: number; targetUserId: number; allowed: boolean }): Promise<void> {
  throw new Error('ORGANIZATION_ADMISSION_RETIRED');
}
