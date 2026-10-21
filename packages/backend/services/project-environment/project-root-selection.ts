import path from 'node:path';

export interface RegisteredProjectRoot {
  project_id: string;
  root_path: string | null;
  archived?: number | boolean | null;
  lifecycle_status?: string | null;
}
export interface ExpectedProjectRoot {
  projectId: string;
  projectRoot: string;
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}
function active(row: RegisteredProjectRoot): boolean {
  // Null lifecycle is the legacy active state; pending/blocked/retired are not active.
  return !row.archived && (row.lifecycle_status == null || row.lifecycle_status === 'active' || row.lifecycle_status === 'ready');
}

/** Resolve the deepest registered boundary BEFORE checking lifecycle. Inactive
 * nested roots remain barriers, while retired aliases at the very same root do
 * not shadow a live Project. Never turn ambiguity into a host-storage fallback. */
export function selectRegisteredProjectRoot(
  rows: RegisteredProjectRoot[], hostPath: string, expected?: ExpectedProjectRoot,
): RegisteredProjectRoot | undefined {
  const candidate = path.resolve(hostPath);
  const matches = rows.filter(row => row.root_path && contains(path.resolve(row.root_path), candidate));
  if (!matches.length) {
    if (expected) throw new Error('PROJECT_WORKSPACE_AUTHORITY_MISMATCH');
    return undefined;
  }
  const deepest = Math.max(...matches.map(row => path.resolve(row.root_path!).length));
  const boundary = matches.filter(row => path.resolve(row.root_path!).length === deepest);
  if (expected) {
    const root = path.resolve(expected.projectRoot);
    const exact = boundary.filter(row => row.project_id === expected.projectId && path.resolve(row.root_path!) === root);
    if (exact.length !== 1) throw new Error('PROJECT_WORKSPACE_AUTHORITY_MISMATCH');
    if (!active(exact[0])) throw new Error('PROJECT_WORKSPACE_AUTHORITY_INACTIVE');
    return exact[0];
  }
  const candidates = boundary.filter(active);
  if (!candidates.length) throw new Error('PROJECT_WORKSPACE_AUTHORITY_INACTIVE');
  if (candidates.length !== 1) throw new Error('PROJECT_WORKSPACE_AUTHORITY_AMBIGUOUS');
  return candidates[0];
}
