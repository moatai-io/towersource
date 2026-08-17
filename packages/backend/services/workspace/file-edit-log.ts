/**
 * file-edit-log.ts — per-session file-edit log writer + SDK PostToolUse hook.
 *
 * Captures (session_id, file_path, tool_name) for tool invocations that
 * modify files. Used by session-backlinks to find "other sessions that
 * edited the same files" regardless of engine.
 *
 * Data flow (post 2026-05-20 unification — PG single source of truth):
 *   - Claude engine: makePostToolUseFileEditLog() factory in claude-sdk.ts
 *     queryOptions.hooks.PostToolUse → recordFileEdit() → session_file_edits.
 *     (The legacy ~/.claude/hooks/memory/post-tool-use.mjs still writes to
 *      memory.db but Tower no longer reads from it.)
 *   - Pi engine: pi-engine.ts tool_execution_end → recordFileEdit().
 *   - Local engine / future harnesses: same hook point pattern.
 *
 * See: workspace/decisions/2026-04-21-session-backlinks-level1.md (origin)
 *      workspace/decisions/2026-05-20-session-file-edits-pg-unification.md (PG unification)
 *      workspace/decisions/2026-05-09-tower-hooks-via-sdk-options.md (SDK hooks policy)
 */
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { execute } from '../../db/pg-repo.js';

const HOME = homedir();
const WORKSPACE = resolve(HOME, 'workspace');
const TOWER_REPO = resolve(HOME, 'tower');

/**
 * Record a file edit event. Fire-and-forget at the callsite — failures are
 * logged but never thrown up to the tool-execution loop. Missing a row here
 * just degrades backlink quality, never breaks the user's turn.
 *
 * ON CONFLICT DO UPDATE — (session_id, file_path) is UNIQUE (migration 063).
 * Repeated edits of the same file in one session collapse to a single row.
 * `created_at` is refreshed to NOW() on every touch so the column semantics
 * are *"most recent edit time"* — used by the sidebar session files panel
 * (decision `2026-05-22-sidebar-session-files-panel.md`) to surface the
 * working set in recency order. The first `tool_name` wins (kept unchanged); backlinks use
 * DISTINCT and don't depend on either column, so this is safe.
 *
 * @param sessionId — Tower sessions.id (UUID), not claude_session_id. Stable
 *                    across engines; doesn't suffer the Pi .jsonl-path overload.
 * @param filePath  — absolute path of the edited file.
 * @param toolName  — 'Edit' | 'Write' | 'NotebookEdit' | 'unknown' (backfill) | etc.
 */
export async function recordFileEdit(
  sessionId: string,
  filePath: string,
  toolName: string,
): Promise<void> {
  if (!sessionId || !filePath) return;
  try {
    await execute(
      `INSERT INTO session_file_edits (session_id, file_path, tool_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id, file_path)
         DO UPDATE SET created_at = NOW()`,
      [sessionId, filePath, toolName || 'unknown'],
    );
  } catch (err) {
    // Session FK violation (session was deleted mid-turn) is the expected
    // failure; log and move on. Anything else is also non-fatal here.
    console.warn(
      `[file-edit-log] recordFileEdit failed session=${sessionId.slice(0, 8)} file=${filePath}: ${(err as Error).message}`,
    );
  }
}

// ── Path predicates (mirror audit/hook.ts so we only log tracked paths) ───
// We restrict logging to ~/workspace/ and ~/tower/. Edits in /tmp, scratch
// dirs, or random places aren't useful as backlink evidence and would just
// dilute scores.

function resolvePath(p: string | null | undefined, cwd: string): string | null {
  if (!p) return null;
  let s = p.replace(/^['"]|['"]$/g, '');
  if (s.startsWith('~/')) s = HOME + s.slice(1);
  return resolve(cwd || HOME, s);
}

function isTracked(absPath: string | null): absPath is string {
  if (!absPath) return false;
  return absPath.startsWith(WORKSPACE + sep) || absPath.startsWith(TOWER_REPO + sep);
}

/**
 * Factory: SDK PostToolUse hook that records file edits for Claude engine
 * sessions. Mirrors the pattern of makePostToolUseProvenance() in audit/hook.ts.
 *
 * The factory closes over the Tower sessions.id so the row lands keyed to the
 * stable Tower id (not the per-turn SDK session_id, which rotates on resume).
 *
 * Returns a hook that always resolves `{ continue: true }` — file-edit logging
 * must never block the user's turn. Errors are swallowed in recordFileEdit().
 */
export function makePostToolUseFileEditLog(towerSessionId: string | null) {
  return async function postToolUseFileEditLog(
    input: HookInput,
    _toolUseID: string | undefined,
    _opts: { signal: AbortSignal },
  ): Promise<HookJSONOutput> {
    if (!towerSessionId) return { continue: true };
    try {
      if (input.hook_event_name !== 'PostToolUse') return { continue: true };
      const toolName = input.tool_name ?? '';
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const cwd = input.cwd || HOME;

      let filePath: string | null = null;
      if (toolName === 'Write' || toolName === 'Edit') {
        filePath = resolvePath(toolInput.file_path as string | undefined, cwd);
      } else if (toolName === 'NotebookEdit') {
        filePath = resolvePath(toolInput.notebook_path as string | undefined, cwd);
      } else {
        return { continue: true }; // not an edit-shaped tool
      }

      if (!isTracked(filePath)) return { continue: true };

      // Fire-and-forget — wait one microtask so the INSERT actually queues,
      // but don't propagate errors. recordFileEdit() already swallows them.
      void recordFileEdit(towerSessionId, filePath, toolName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[file-edit-log] hook error: ${msg}`);
    }
    return { continue: true };
  };
}
