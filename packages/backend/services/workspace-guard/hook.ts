/**
 * Owns: PreToolUse hook for AI sessions — block creation of new top-level
 *   folders/files under ~/workspace/. Existing entries pass through
 *   (so ongoing work isn't disturbed). Special case: ~/workspace/projects/<X>/
 *   creation is blocked — projects must go through the project-create API
 *   to avoid "ghost projects".
 * Public API: preToolUseWorkspaceGuard — wired in claude-sdk.ts queryOptions.
 * See README.md and ../../../../docs/tower-guide/ai-execution-paths.md §3-2.
 *
 * Why SDK hook instead of external .mjs:
 *   workspace/decisions/2026-05-11-hook-parity-self-hosted-servers.md.
 *   External ~/.claude/hooks/workspace-guard/pre-tool-use.mjs is admin-CLI
 *   only — Tower web sessions on self-hosted servers need this in-process hook so
 *   ghost-project mkdir is actually blocked via self-host deploy alone.
 *
 * Override: TOWER_WORKSPACE_UNRESTRICTED=1 in env (admin escape hatch).
 *
 * Audit log: ~/workspace/.audit/root-write-blocks.log (mirrors legacy .mjs).
 */
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

const HOME = homedir();
const WORKSPACE = resolve(HOME, 'workspace');
const AUDIT_DIR = resolve(WORKSPACE, '.audit');
const AUDIT_LOG = resolve(AUDIT_DIR, 'root-write-blocks.log');
const OVERRIDE_LOG = resolve(AUDIT_DIR, 'admin-overrides.log');

/**
 * Canonical workspace roots that always pass. Mirrors the legacy external
 * .mjs allowlist exactly — single source of truth for "what belongs at
 * workspace/". Everything else must live inside projects/<p>/.
 */
const ALLOWED_ROOTS = new Set<string>([
  'projects',
  'published',
  'decisions',
  'docs',
  'templates',
  'scripts',
  '.audit',
  // System / tool-managed (always exist)
  '.claude',
  '.git',
  '.worktrees',
  '.temp-uploads',
]);

interface BlockResult {
  blocked: boolean;
  segment?: string;
  reason?: string;
  grandfathered?: boolean;
}

interface BlockLogEntry {
  ts: string;
  sessionId: string | null;
  towerSessionId?: string;
  toolName: string;
  attemptedPath: string;
  segment?: string;
  toolInput: Record<string, unknown>;
}

function ensureAuditDir(): void {
  try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch { /* swallow */ }
}

function logBlock(entry: BlockLogEntry): void {
  ensureAuditDir();
  try {
    appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
  } catch { /* hook must never throw */ }
}

function logOverride(entry: { ts: string; reason: string }): void {
  ensureAuditDir();
  try {
    appendFileSync(OVERRIDE_LOG, JSON.stringify(entry) + '\n');
  } catch { /* swallow */ }
}

function resolvePath(p: string | null | undefined, cwd: string): string | null {
  if (!p) return null;
  let s = p.replace(/^['"]|['"]$/g, '');
  if (s.startsWith('~/')) s = HOME + s.slice(1);
  return resolve(cwd || HOME, s);
}

/**
 * First segment under workspace/, or null if path is not under workspace/.
 *   /home/X/workspace/foo/bar      → "foo"
 *   /home/X/workspace/AGENTS.md     → "AGENTS.md"
 *   /home/X/other/x                → null
 */
function workspaceSegment(absPath: string): string | null {
  if (!absPath.startsWith(WORKSPACE + sep)) return null;
  const rel = absPath.slice(WORKSPACE.length + 1);
  if (!rel) return null;
  return rel.split(sep)[0] || null;
}

function checkPath(absPath: string): BlockResult {
  const seg = workspaceSegment(absPath);
  if (!seg) return { blocked: false };

  // Special case: workspace/projects/<X>/...
  // 'projects' is allowed, but new <X> must go through project-create API.
  // Decision: workspace/decisions/2026-05-04-projects-mkdir-policy.md
  if (seg === 'projects') {
    const rel = absPath.slice(WORKSPACE.length + 1);
    const parts = rel.split(sep);
    if (parts.length >= 2 && parts[1]) {
      const projectName = parts[1];
      const projectPath = resolve(WORKSPACE, 'projects', projectName);
      if (!existsSync(projectPath)) {
        return {
          blocked: true,
          segment: `projects/${projectName}`,
          reason:
            `Creating new project folder "workspace/projects/${projectName}/" is blocked.\n\n` +
            `Tower projects must be created via the project API/UI/CLI — \n` +
            `otherwise the DB row, AGENTS.md template, .project/ dir, sidebar\n` +
            `entry, and session context inheritance never get set up\n` +
            `(it becomes a "ghost project").\n\n` +
            `Use one of:\n` +
            `  • Sidebar: click the "+" next to "Projects".\n` +
            `  • CLI:     ~/workspace/scripts/tower-project-create.sh ${projectName}\n` +
            `  • API:     curl -X POST -H "Authorization: Bearer $TOWER_API_TOKEN" \\\n` +
            `             -H "Content-Type: application/json" \\\n` +
            `             -d '{"name":"${projectName}"}' "$TOWER_API_URL/api/projects"\n\n` +
            `If this is a temp scratch dir for an existing project, use:\n` +
            `  workspace/projects/<existing>/experiments/${projectName}/\n\n` +
            `Admin override (rare): re-run with TOWER_WORKSPACE_UNRESTRICTED=1 in env.\n` +
            `Decision: workspace/decisions/2026-05-04-projects-mkdir-policy.md`,
        };
      }
    }
    return { blocked: false };
  }

  if (ALLOWED_ROOTS.has(seg)) return { blocked: false };
  const segPath = resolve(WORKSPACE, seg);
  if (existsSync(segPath)) return { blocked: false, segment: seg, grandfathered: true };
  return {
    blocked: true,
    segment: seg,
    reason:
      `New top-level entry "workspace/${seg}/" is blocked by workspace-guard.\n\n` +
      `Allowed roots: ${[...ALLOWED_ROOTS].sort().join(', ')}\n\n` +
      `What to do instead:\n` +
      `  • If this is part of a project → use workspace/projects/<project>/${seg}/...\n` +
      `  • If you don't know which project → ask the user which project this belongs to.\n` +
      `  • If it's general research/docs → workspace/docs/research/<topic>.md\n\n` +
      `Admin override (rare): re-run with TOWER_WORKSPACE_UNRESTRICTED=1 in env.`,
  };
}

/**
 * Extract path-creating targets from a bash command. Mirrors legacy .mjs
 * extractWriteTargets. Conservative — high-signal verbs only.
 */
function extractWriteTargets(cmd: string): string[] {
  const targets: string[] = [];
  const parts = cmd.split(/&&|\|\||;|\|(?!\|)/);
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;

    // mkdir [-p] [-m mode] <path>...
    let m = part.match(/^\s*mkdir\b(.*)$/);
    if (m) {
      const args = m[1].trim().split(/\s+/).filter(Boolean);
      for (const a of args) {
        if (a.startsWith('-')) continue;
        targets.push(a);
      }
      continue;
    }

    // touch <path>...
    m = part.match(/^\s*touch\b(.*)$/);
    if (m) {
      const args = m[1].trim().split(/\s+/).filter(Boolean);
      for (const a of args) {
        if (a.startsWith('-')) continue;
        targets.push(a);
      }
      continue;
    }

    // git clone [opts...] <url> [<dst>]
    m = part.match(/^\s*git\s+clone\b(.*)$/);
    if (m) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      if (args.length >= 2) targets.push(args[1]);
      continue;
    }

    // git worktree add [opts...] <dst> [<commit>]
    m = part.match(/^\s*git\s+worktree\s+add\b(.*)$/);
    if (m) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      if (args[0]) targets.push(args[0]);
      continue;
    }

    // cp/mv [opts...] <src>... <dst>
    m = part.match(/^\s*(?:cp|mv)\b(.*)$/);
    if (m) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      if (args.length >= 2) targets.push(args[args.length - 1]);
      continue;
    }
  }
  return targets;
}

/**
 * Factory: build a PreToolUse callback bound to a specific Tower session id.
 * The session id is recorded with each block event in
 * `~/workspace/.audit/root-write-blocks.log` so admin can trace which session
 * tried to ghost-mkdir.
 *
 * Why a factory: see audit/hook.ts comment — `process.env.TOWER_SESSION_ID`
 * isn't visible from backend parent process where SDK callbacks run. The
 * deny logic itself doesn't depend on session id (allowed roots are global),
 * but binding the id lets the audit log be useful for forensics.
 * Decision: workspace/decisions/2026-05-11-hook-parity-self-hosted-servers.md
 */
export function makePreToolUseWorkspaceGuard(towerSessionId: string | null) {
  return async function preToolUseWorkspaceGuard(
    input: HookInput,
    _toolUseID: string | undefined,
    _opts: { signal: AbortSignal },
  ): Promise<HookJSONOutput> {
  try {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };

    // Admin override
    if (process.env.TOWER_WORKSPACE_UNRESTRICTED === '1') {
      logOverride({ ts: new Date().toISOString(), reason: 'TOWER_WORKSPACE_UNRESTRICTED=1' });
      return { continue: true };
    }

    const toolName = input.tool_name ?? '';
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const cwd = input.cwd || HOME;
    const sessionId = (input as unknown as { session_id?: string }).session_id ?? null;

    const pathsToCheck: string[] = [];

    if (toolName === 'Write' || toolName === 'Edit') {
      const p = resolvePath(toolInput.file_path as string | undefined, cwd);
      if (p) pathsToCheck.push(p);
    } else if (toolName === 'NotebookEdit') {
      const p = resolvePath(toolInput.notebook_path as string | undefined, cwd);
      if (p) pathsToCheck.push(p);
    } else if (toolName === 'Bash') {
      const cmd = (toolInput.command as string | undefined) || '';
      const targets = extractWriteTargets(cmd);
      for (const t of targets) {
        const p = resolvePath(t, cwd);
        if (p) pathsToCheck.push(p);
      }
    } else {
      return { continue: true };
    }

    for (const p of pathsToCheck) {
      const r = checkPath(p);
      if (r.blocked && r.reason) {
        logBlock({
          ts: new Date().toISOString(),
          sessionId,
          ...(towerSessionId ? { towerSessionId } : {}),
          toolName,
          attemptedPath: p,
          segment: r.segment,
          toolInput:
            toolName === 'Bash'
              ? { command: toolInput.command }
              : { file_path: toolInput.file_path ?? toolInput.notebook_path },
        });
        console.warn(`[workspace-guard] blocked path=${p}`);
        return {
          decision: 'block',
          reason: r.reason,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: r.reason,
          },
        };
      }
    }

    return { continue: true };
  } catch (err: unknown) {
    // Never throw — defaults to allow.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[workspace-guard] error: ${msg}`);
    return { continue: true };
  }
  };
}
