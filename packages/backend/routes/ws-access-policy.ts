import { isPrivilegedRole } from '../services/pm/project-access.js';

/**
 * Safe fallback when the project ACL lookup fails before a WebSocket AI run.
 *
 * Privileged roles intentionally retain workspace-wide access. Every other
 * authenticated role gets an empty project list so the tool guard fails closed.
 */
export function accessiblePathsFallbackForRole(role: string | undefined | null): string[] | null {
  return isPrivilegedRole(role) ? null : [];
}
