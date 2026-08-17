/**
 * Owns: PostToolUse hook for AI sessions — append a provenance record to
 *   ~/workspace/.audit/provenance.jsonl every time a Write/Edit/NotebookEdit/
 *   Bash call touches a tracked path (~/workspace/ or ~/tower/).
 * Public API: makePostToolUseProvenance — wired in engine hook options.
 * See README.md and ../../../../docs/tower-guide/ai-execution-paths.md §3-2.
 *
 * Why SDK hook instead of external .mjs:
 *   workspace/decisions/2026-05-11-hook-parity-self-hosted-servers.md.
 *   External ~/.claude/hooks/workspace-guard/post-tool-use.mjs is admin-CLI
 *   only — Tower web sessions on self-hosted servers need this in-process hook so
 *   /commit-session and multi-session safety work via self-host deploy alone.
 *
 * Output remains backward-compatible with the legacy external .mjs fields
 * (`sessionId`, `towerSessionId`, `tool`, `action`, `path`, `src?`) while
 * adding schema v2 normalized fields (`engineSessionId`, `repo`, `relpath`,
 * `scope`, `cwd`) so consumers no longer guess path semantics.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

const HOME = homedir();
const WORKSPACE = resolve(HOME, 'workspace');
const AUDIT_DIR = resolve(WORKSPACE, '.audit');
const PROVENANCE_LOG = resolve(AUDIT_DIR, 'provenance.jsonl');

// Tower repo path — admin's code workspace. On self-hosted servers this is also
// ~/tower/ (mirrored), so the same path predicate works for both. If the
// directory doesn't exist on a given VM, isInTowerRepo() simply returns
// false and no records are emitted for those paths.
const TOWER_REPO = resolve(HOME, 'tower');

export type ProvenanceScope = 'tower-repo' | 'workspace';

interface ProvenanceRecord {
  /** Additive schema marker. Legacy consumers can ignore it. */
  schemaVersion: 2;
  ts: string;
  /** Legacy SDK/Pi engine session id field. Kept for old grep/jq consumers. */
  sessionId: string | null;
  /** Explicit engine session id alias for schema v2 consumers. */
  engineSessionId: string | null;
  /** Stable Tower DB session UUID. This is what $TOWER_SESSION_ID carries. */
  towerSessionId?: string;
  userId: string | null;
  username?: string;
  tool: string;
  action: string;
  path: string;
  cwd: string;
  scope: ProvenanceScope;
  repo: string;
  relpath: string;
  src?: string;
  commandHash?: string;
  commandPreview?: string;
  /** Raw command is off by default; enable only for local forensic debugging. */
  command?: string;
}

interface BashTarget {
  action: string;
  target: string;
  src?: string;
}

interface ProvenanceIdentity {
  userId?: number | string | null;
  username?: string | null;
}

export interface NormalizedTrackedPath {
  path: string;
  cwd: string;
  scope: ProvenanceScope;
  repo: string;
  relpath: string;
}

function ensureAuditDir(): void {
  try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch { /* swallow */ }
}

function logEntry(entry: ProvenanceRecord): void {
  ensureAuditDir();
  try {
    appendFileSync(PROVENANCE_LOG, JSON.stringify(entry) + '\n');
  } catch { /* hook must never throw */ }
}

function resolvePath(p: string | null | undefined, cwd: string): string | null {
  if (!p || isSuspiciousPathToken(p)) return null;
  let s = p.replace(/^['"]|['"]$/g, '');
  if (s.startsWith('~/')) s = HOME + s.slice(1);
  return resolve(cwd || HOME, s);
}

function isInWorkspace(absPath: string): boolean {
  return absPath.startsWith(WORKSPACE + sep);
}

function isInTowerRepo(absPath: string): boolean {
  return absPath.startsWith(TOWER_REPO + sep);
}

export function normalizeTrackedPath(absPath: string | null, cwd: string): NormalizedTrackedPath | null {
  if (!absPath) return null;
  if (isInTowerRepo(absPath)) {
    return {
      path: absPath,
      cwd,
      scope: 'tower-repo',
      repo: TOWER_REPO,
      relpath: relative(TOWER_REPO, absPath),
    };
  }
  if (isInWorkspace(absPath)) {
    return {
      path: absPath,
      cwd,
      scope: 'workspace',
      repo: WORKSPACE,
      relpath: relative(WORKSPACE, absPath),
    };
  }
  return null;
}

function normalizeSourcePath(src: string | undefined, cwd: string, repo: string): string | undefined {
  if (!src || isSuspiciousPathToken(src)) return undefined;
  const first = src.trim().split(/\s+/)[0];
  const abs = resolvePath(first, cwd);
  if (!abs || !abs.startsWith(repo + sep)) return undefined;
  return relative(repo, abs);
}

/**
 * Reject shell syntax that is often not a real path. This intentionally runs
 * before resolve(cwd, token), because otherwise `2>/dev/null` becomes a fake
 * repo path like `/home/.../tower/2>/dev/null`.
 */
export function isSuspiciousPathToken(token: string): boolean {
  const s = token.trim();
  if (!s || s === '.' || s === '..') return true;
  if (/^[-]$/.test(s)) return true;
  if (/^(https?|ssh|git):/i.test(s)) return true;
  if (/[$`*?{}\[\]<>|;&]/.test(s)) return true;
  if (/^\d?>/.test(s) || /^\d?<</.test(s)) return true;
  if (s.includes('>/') || s.includes('<')) return true;
  return s.split('/').some((part) => part.startsWith('$'));
}

function redactCommand(cmd: string): string {
  return cmd
    .replace(/sk-[A-Za-z0-9]{10,}/g, 'sk-…')
    .replace(/gh[pous]_[A-Za-z0-9]{10,}/g, 'gh…')
    .replace(/xox[bpoa]-[A-Za-z0-9-]{10,}/g, 'xox…')
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA…')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN … PRIVATE KEY-----')
    .replace(/\s+/g, ' ')
    .trim();
}

function commandHash(cmd: string): string {
  return `sha256:${createHash('sha256').update(cmd).digest('hex').slice(0, 16)}`;
}

function commandPreview(cmd: string): string {
  const redacted = redactCommand(cmd);
  return redacted.length > 160 ? `${redacted.slice(0, 157)}...` : redacted;
}

/**
 * Extract write-action targets from a bash command.
 * Conservative — only high-signal verbs to keep false positives low.
 */
export function extractBashTargets(cmd: string): BashTarget[] {
  const out: BashTarget[] = [];
  const parts = cmd.split(/&&|\|\||;|\|(?!\|)/);
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;

    // mkdir / touch / rmdir
    let m = part.match(/^\s*(mkdir|touch|rmdir)\b(.*)$/);
    if (m) {
      const action = m[1];
      const args = m[2].trim().split(/\s+/).filter((a) => a && !a.startsWith('-') && !isSuspiciousPathToken(a));
      for (const a of args) out.push({ action, target: a });
      continue;
    }

    // rm
    m = part.match(/^\s*rm\b(.*)$/);
    if (m) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-') && !isSuspiciousPathToken(a));
      for (const a of args) out.push({ action: 'rm', target: a });
      continue;
    }

    // cp / mv — record dest
    m = part.match(/^\s*(cp|mv)\b(.*)$/);
    if (m) {
      const action = m[1];
      const args = m[2].trim().split(/\s+/).filter((a) => a && !a.startsWith('-') && !isSuspiciousPathToken(a));
      if (args.length >= 2) {
        out.push({ action, target: args[args.length - 1], src: args.slice(0, -1).join(' ') });
      }
      continue;
    }

    // git clone <url> <dst>
    m = part.match(/^\s*git\s+clone\b(.*)$/);
    if (m) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      const src = args[0];
      const dst = args[1];
      if (src && dst && !isSuspiciousPathToken(dst)) out.push({ action: 'git-clone', target: dst, src });
      continue;
    }

    // git worktree add <dst>
    m = part.match(/^\s*git\s+worktree\s+add\b(.*)$/);
    if (m) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-') && !isSuspiciousPathToken(a));
      if (args[0]) out.push({ action: 'git-worktree-add', target: args[0] });
      continue;
    }
  }
  return out;
}

/**
 * Factory: build a PostToolUse callback bound to a specific Tower session id.
 *
 * The returned hook always returns `{ continue: true }`. Like publishing/hook.ts,
 * sync appendFileSync is awaited — microseconds, easier to debug than a
 * detached promise.
 */
export function makePostToolUseProvenance(
  towerSessionId: string | null,
  identity: ProvenanceIdentity = {},
) {
  return async function postToolUseProvenance(
    input: HookInput,
    _toolUseID: string | undefined,
    _opts: { signal: AbortSignal },
  ): Promise<HookJSONOutput> {
  try {
    if (input.hook_event_name !== 'PostToolUse') return { continue: true };
    const toolName = input.tool_name ?? '';
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const cwd = input.cwd || HOME;

    const userId = identity.userId != null
      ? String(identity.userId)
      : process.env.TOWER_USER_ID || process.env.USER || null;
    const username = identity.username || process.env.TOWER_USERNAME || undefined;
    // SDK/Pi engine session id. Pi adapter currently sets this to the Tower id;
    // still useful as an explicit alias and keeps legacy `sessionId` populated.
    const engineSessionId = (input as unknown as { session_id?: string }).session_id ?? null;
    const ts = new Date().toISOString();

    const records: Array<{ action: string; normalized: NormalizedTrackedPath; src?: string; command?: string }> = [];

    if (toolName === 'Write') {
      const p = normalizeTrackedPath(resolvePath(toolInput.file_path as string | undefined, cwd), cwd);
      if (p) records.push({ action: 'write', normalized: p });
    } else if (toolName === 'Edit') {
      const p = normalizeTrackedPath(resolvePath(toolInput.file_path as string | undefined, cwd), cwd);
      if (p) records.push({ action: 'edit', normalized: p });
    } else if (toolName === 'NotebookEdit') {
      const p = normalizeTrackedPath(resolvePath(toolInput.notebook_path as string | undefined, cwd), cwd);
      if (p) records.push({ action: 'notebook-edit', normalized: p });
    } else if (toolName === 'Bash') {
      const cmd = (toolInput.command as string | undefined) || '';
      const targets = extractBashTargets(cmd);
      for (const t of targets) {
        const p = normalizeTrackedPath(resolvePath(t.target, cwd), cwd);
        if (p) {
          records.push({
            action: t.action,
            normalized: p,
            src: normalizeSourcePath(t.src, cwd, p.repo),
            command: cmd,
          });
        }
      }
    }

    if (records.length === 0) return { continue: true };

    for (const r of records) {
      logEntry({
        schemaVersion: 2,
        ts,
        sessionId: engineSessionId,
        engineSessionId,
        ...(towerSessionId ? { towerSessionId } : {}),
        userId,
        ...(username ? { username } : {}),
        tool: toolName,
        action: r.action,
        path: r.normalized.path,
        cwd: r.normalized.cwd,
        scope: r.normalized.scope,
        repo: r.normalized.repo,
        relpath: r.normalized.relpath,
        ...(r.src ? { src: r.src } : {}),
        ...(r.command ? { commandHash: commandHash(r.command), commandPreview: commandPreview(r.command) } : {}),
        ...(r.command && process.env.AUDIT_STORE_RAW_COMMAND === '1' ? { command: r.command.slice(0, 500) } : {}),
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[audit-hook] error: ${msg}`);
  }
  return { continue: true };
  };
}
