/** Installed launcher policy, never populated from command/tool request fields.
 * Validation only: does not grant permission, switch UID, or prove filesystem ACLs.
 */
import path from 'node:path';
export interface WorkstationCommandIdentity {
  projectId: string;
  uid: number;
  gid: number;
  home: string;
  projectRoot: string;
}
export interface LauncherProcessIdentity {
  uid: number;
  gid: number;
  groups: number[];
}
export function validateWorkstationCommandIdentity(
  policy: WorkstationCommandIdentity,
  input: { projectId: string; controllerUid: number; launcher: LauncherProcessIdentity },
): void {
  const validId = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 0xfffffffe;
  const validPath = (value: string) => typeof value === 'string' && path.isAbsolute(value)
    && value !== '/' && !/[\0\r\n]/.test(value) && path.normalize(value) === value;
  if (!validId(policy.uid) || !validId(policy.gid)
    || !validPath(policy.home) || !validPath(policy.projectRoot) || !policy.projectId) {
    throw new Error('WORKSTATION_COMMAND_POLICY_INVALID');
  }
  if (input.projectId !== policy.projectId) throw new Error('WORKSTATION_COMMAND_PROJECT_MISMATCH');
  if (!Number.isSafeInteger(input.controllerUid) || input.controllerUid < 0
    || input.controllerUid > 0xfffffffe || input.controllerUid === policy.uid) {
    throw new Error('WORKSTATION_CONTROLLER_IDENTITY_NOT_SEPARATED');
  }
  // A pre-started nonprivileged launcher must already have the installed identity.
  // Do not turn a network-facing controller into a root/setuid command executor.
  if (input.launcher.uid !== policy.uid || input.launcher.gid !== policy.gid) {
    throw new Error('WORKSTATION_LAUNCHER_IDENTITY_MISMATCH');
  }
  if (!Array.isArray(input.launcher.groups)
    || input.launcher.groups.some(group => group !== policy.gid)) {
    throw new Error('WORKSTATION_LAUNCHER_SUPPLEMENTARY_GROUPS_DENIED');
  }
}
