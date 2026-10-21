import { constants } from 'node:fs';

/** Linux UAPI O_PATH: Node does not expose it on all supported installations.
 * A path descriptor pins directory identity without directory-list read access.
 * Final file opens/readdir must still request their operation-specific rights.
 * Never use this numeric flag on a non-Linux OS.
 */
export function linuxPathDirectoryFlags(): number {
  if (process.platform !== 'linux') throw new Error('WORKSPACE_HOST_PLATFORM_UNSUPPORTED');
  return 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}
