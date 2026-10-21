/** Service-account ACL encoding only. This never grants app users or Agents access.
 * Fresh roots use a complete private ACL. Migration merges peer grants only;
 * callers must preserve existing effective rights and validate boundaries first.
 */
function assertPeers(backendUid: number, executorUid: number): void {
  if (![backendUid, executorUid].every(uid => Number.isSafeInteger(uid) && uid > 0) || backendUid === executorUid) throw new Error('PROJECT_PEER_ACL_IDENTITIES_INVALID');
}
export function freshProjectPeerAcl(backendUid: number, executorUid: number, executorPermissions: 'rwx' | 'r-x'): string[] {
  assertPeers(backendUid, executorUid);
  return ['u::rwx', `u:${backendUid}:rwx`, `u:${executorUid}:${executorPermissions}`, 'g::---', 'm::rwx', 'o::---',
    'd:u::rwx', `d:u:${backendUid}:rwx`, `d:u:${executorUid}:${executorPermissions}`, 'd:g::---', 'd:m::rwx', 'd:o::---'];
}
export function migrationProjectPeerAcl(backendUid: number, executorUid: number, directory: boolean, executable: boolean): string[] {
  assertPeers(backendUid, executorUid);
  const permissions = directory || executable ? 'rwx' : 'rw-';
  const entries = [`u:${backendUid}:${permissions}`, `u:${executorUid}:${permissions}`, 'm::rwx'];
  if (directory) entries.push(`d:u:${backendUid}:rwx`, `d:u:${executorUid}:rwx`, 'd:m::rwx');
  return entries;
}
