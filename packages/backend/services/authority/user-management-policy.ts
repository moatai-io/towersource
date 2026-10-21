/** Company operators manage ordinary accounts, never peer/platform administrators. */
export function canManageUserRole(actorRole: string, targetRole?: string, nextRole?: string): boolean {
  if (actorRole === 'admin') return true;
  if (actorRole !== 'operator') return false;
  const ordinary = new Set(['member', 'viewer', 'guest']);
  return (targetRole === undefined || ordinary.has(targetRole))
    && (nextRole === undefined || ordinary.has(nextRole));
}
