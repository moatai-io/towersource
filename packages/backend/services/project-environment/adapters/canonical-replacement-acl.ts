/** Retain group access without requiring membership/chown to the old file group.
 * Reject ambiguous overlapping group entries rather than merging privileges.
 * Existing named users/mask/private modes are retained. No broad ACL repair. */
export function replacementAccessAcl(acl: string, oldGroup: number, newGroup: number, oldOwner?: number, newOwner?: number): string {
  if (oldOwner !== undefined && newOwner !== undefined && oldOwner !== newOwner) {
    const rows = acl.split('\n').map(line => line.split('#')[0].trim()).filter(Boolean);
    const owner = rows.find(line => line.startsWith('user::'))?.slice(6);
    const mask = rows.find(line => line.startsWith('mask::'))?.slice(6) || rows.find(line => line.startsWith('group::'))?.slice(7);
    if (!owner || !mask) throw new Error('WORKSPACE_REPLACEMENT_ACL_INVALID');
    const effective = (permissions: string) => permissions.split('').map((ch, index) => mask[index] === '-' ? '-' : ch).join('');
    // Raising the mask for the former owner must not activate dormant grants.
    const clamped = rows.filter(line => !line.startsWith('mask::') && !line.startsWith(`user:${oldOwner}:`)).map(line => {
      const parts = line.split(':');
      if (parts[0] === 'group' || parts[0] === 'user' && parts[1]) parts[2] = effective(parts[2]);
      return parts.join(':');
    });
    const raised = mask.split('').map((ch, index) => ch !== '-' ? ch : owner[index]).join('');
    clamped.push(`user:${oldOwner}:${owner}`, `mask::${raised}`);
    acl = clamped.join('\n') + '\n';
  }
  if (oldGroup === newGroup) return acl;
  const lines = acl.split('\n').map(line => line.split('#')[0].trim()).filter(Boolean);
  const value = (prefix: string) => lines.find(line => line.startsWith(prefix))?.slice(prefix.length);
  const group = value('group::'); const other = value('other::');
  if (!group || !other) throw new Error('WORKSPACE_REPLACEMENT_ACL_INVALID');
  const oldNamed = value(`group:${oldGroup}:`);
  // Original owning-group and named-group entries coexist under the old inode.
  // Different entries must not be unioned into a broader single entry.
  if (oldNamed && oldNamed !== group) throw new Error('WORKSPACE_REPLACEMENT_GROUP_AMBIGUOUS');
  const newNamed = value(`group:${newGroup}:`);
  const mask = value('mask::') || group;
  const result = lines.filter(line => line !== `group::${group}` && !line.startsWith('mask::')
    && !line.startsWith(`group:${oldGroup}:`) && !line.startsWith(`group:${newGroup}:`));
  // The new owning group receives its previously named grant, or only other access.
  // Effective perms must not exceed the original mask when entering the group class.
  const perms = (newNamed || other).split('').map((c, i) => mask[i] === '-' ? '-' : c).join('');
  result.push(`group::${perms}`, `group:${oldGroup}:${group}`, `mask::${mask}`);
  return result.join('\n') + '\n';
}
