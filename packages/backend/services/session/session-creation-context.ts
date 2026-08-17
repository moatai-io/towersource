// Owns: cwd/project inheritance for newly-created sessions and AI panel threads.
// Public API: resolveSessionCreationContext(). See services/session/README.md.
import { config } from '../../config.js';
import { queryOne } from '../../db/pg-repo.js';
import { findProjectByPath } from '../pm/project-access.js';
import { getDefaultProjectIds } from '../pm/project-manager.js';

export interface SessionCreationContextInput {
  cwd?: string | null;
  projectId?: string | null;
  parentSessionId?: string | null;
  roomId?: string | null;
  userId?: number | null;
  role?: string | null;
}

export interface SessionCreationContext {
  cwd: string;
  projectId: string | null | undefined;
}

interface ParentSessionRow {
  cwd: string | null;
  project_id: string | null;
  project_root_path: string | null;
}

interface RoomProjectRow {
  project_id: string | null;
  project_root_path: string | null;
}

function cleanString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function getProjectRootPath(projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  const row = await queryOne<{ root_path: string | null }>(
    'SELECT root_path FROM projects WHERE id = $1',
    [projectId],
  );
  return row?.root_path ?? null;
}

async function getDefaultProjectContext(role: string | null | undefined): Promise<SessionCreationContext | null> {
  const [projectId] = await getDefaultProjectIds(role || 'member');
  if (!projectId) return null;
  const rootPath = await getProjectRootPath(projectId);
  if (!rootPath) return null;
  return { cwd: rootPath, projectId };
}

/**
 * Resolve the project/cwd pair for a new session.
 *
 * Rule of thumb: when a project can be inferred, cwd must follow the project
 * root instead of falling back to workspace root. This keeps AI panel threads,
 * room threads, Runtime Box mounts, and credential injection aligned.
 */
export async function resolveSessionCreationContext(input: SessionCreationContextInput): Promise<SessionCreationContext> {
  let projectId = cleanString(input.projectId);
  const explicitCwd = cleanString(input.cwd);

  // Explicit cwd is an intentional override. If caller omitted projectId, keep
  // the existing cwd→project inference behavior for backwards compatibility.
  if (explicitCwd) {
    if (!projectId) projectId = await findProjectByPath(explicitCwd);
    return { cwd: explicitCwd, projectId };
  }

  const parentSessionId = cleanString(input.parentSessionId);
  if (parentSessionId) {
    const parent = await queryOne<ParentSessionRow>(
      `SELECT s.cwd, s.project_id, p.root_path AS project_root_path
         FROM sessions s
         LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.id = $1`,
      [parentSessionId],
    );

    if (parent) {
      if (!projectId) projectId = parent.project_id;
      const rootPath = projectId === parent.project_id
        ? parent.project_root_path
        : await getProjectRootPath(projectId);
      return { cwd: rootPath ?? parent.cwd ?? config.defaultCwd, projectId };
    }
  }

  const roomId = cleanString(input.roomId);
  if (roomId) {
    const room = await queryOne<RoomProjectRow>(
      `SELECT r.project_id, p.root_path AS project_root_path
         FROM chat_rooms r
         LEFT JOIN projects p ON p.id = r.project_id
        WHERE r.id = $1`,
      [roomId],
    );

    if (room) {
      if (!projectId) projectId = room.project_id;
      const rootPath = projectId === room.project_id
        ? room.project_root_path
        : await getProjectRootPath(projectId);
      if (rootPath) return { cwd: rootPath, projectId };
    }
  }

  const projectRootPath = await getProjectRootPath(projectId);
  if (projectRootPath) return { cwd: projectRootPath, projectId };

  // Last non-null-project fallback for new top-level sessions. Frontend usually
  // supplies General, but first-login/onboarding paths can race before project
  // metadata is loaded. Prefer the VM's signup-visible default project and keep
  // project-less `temp` sessions only for cases where no default project exists.
  const defaultProject = await getDefaultProjectContext(input.role);
  if (defaultProject) return defaultProject;

  return { cwd: config.defaultCwd, projectId };
}
