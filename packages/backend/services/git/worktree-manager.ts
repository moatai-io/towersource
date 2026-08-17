/**
 * Worktree Manager — create/remove git worktrees for isolated task execution.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const WORKTREES_DIR = '.worktrees';

/**
 * Check if a directory is inside a git repository.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory for a given path.
 */
function getGitRoot(cwd: string): string {
  return execSync('git rev-parse --show-toplevel', {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
}

/**
 * Create a slug from a task title (for branch naming).
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

/**
 * Ensure .worktrees/ is in .gitignore.
 */
function ensureGitignore(gitRoot: string): void {
  const gitignorePath = path.join(gitRoot, '.gitignore');
  const entry = `${WORKTREES_DIR}/`;

  try {
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      if (content.includes(entry)) return;
      fs.appendFileSync(gitignorePath, `\n${entry}\n`);
    } else {
      fs.writeFileSync(gitignorePath, `${entry}\n`);
    }
  } catch (err: any) {
    console.warn(`[worktree] Failed to update .gitignore: ${err.message}`);
  }
}

/**
 * Create a worktree for a task.
 * Returns the worktree path and branch name, or null on failure.
 */
export function createWorktree(
  cwd: string,
  taskId: string,
  title: string,
): { worktreePath: string; branchName: string } | null {
  try {
    if (!isGitRepo(cwd)) {
      console.warn(`[worktree] ${cwd} is not a git repo, skipping worktree creation`);
      return null;
    }

    const gitRoot = getGitRoot(cwd);
    const shortId = taskId.slice(0, 8);
    const slug = slugify(title);
    const branchName = `task/${shortId}-${slug}`;
    const worktreePath = path.join(gitRoot, WORKTREES_DIR, `task-${shortId}`);

    // Ensure the parent directory exists
    const worktreesDir = path.join(gitRoot, WORKTREES_DIR);
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    // Add .worktrees/ to .gitignore
    ensureGitignore(gitRoot);

    // Create the worktree with a new branch
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
      cwd: gitRoot,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    console.log(`[worktree] Created: ${worktreePath} (branch: ${branchName})`);
    return { worktreePath, branchName };
  } catch (err: any) {
    console.error(`[worktree] Failed to create worktree for task ${taskId}: ${err.message}`);
    return null;
  }
}

/**
 * Remove a worktree. Safety check: path must be inside .worktrees/.
 */
export function removeWorktree(worktreePath: string): boolean {
  try {
    // Safety: ensure the path contains .worktrees/
    if (!worktreePath.includes(`/${WORKTREES_DIR}/`) && !worktreePath.includes(`\\${WORKTREES_DIR}\\`)) {
      console.error(`[worktree] Refusing to remove path outside .worktrees/: ${worktreePath}`);
      return false;
    }

    if (!fs.existsSync(worktreePath)) {
      console.warn(`[worktree] Path does not exist: ${worktreePath}`);
      return true; // Already gone
    }

    // Find git root from worktree path
    const gitRoot = getGitRoot(worktreePath);

    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: gitRoot,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    console.log(`[worktree] Removed: ${worktreePath}`);
    return true;
  } catch (err: any) {
    console.error(`[worktree] Failed to remove worktree ${worktreePath}: ${err.message}`);
    return false;
  }
}
