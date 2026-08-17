// Owns: provenance.jsonl appender for inline-edit events. Public API: appendInlineEditAudit.
// See README.md.
//
// Backend-side audit writer. PostToolUse hooks already write to this file from
// SDK-driven sessions; we mirror the same shape for HTTP-driven inline edits
// so a single grep covers both surfaces.

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Resolve the workspace audit log path.
 *
 * Convention (system prompt invariant): the workspace lives at
 * `<home>/workspace/`. In dev we typically run with `WORKSPACE_ROOT=$HOME/workspace`,
 * so `WORKSPACE_ROOT` *is* the workspace dir, not the home dir. If the env
 * var is set we trust it; otherwise we fall back to `<home>/workspace`.
 */
function resolveAuditPath(): string {
  const workspaceDir =
    process.env.WORKSPACE_ROOT && process.env.WORKSPACE_ROOT.trim()
      ? process.env.WORKSPACE_ROOT
      : path.join(os.homedir(), 'workspace');
  const auditDir = path.join(workspaceDir, '.audit');
  return path.join(auditDir, 'provenance.jsonl');
}

export interface InlineEditAuditEntry {
  /** Tower session id if available (frontend may pass it via header). */
  sessionId?: string | null;
  userId: number | null;
  role?: string | null;
  /** Absolute path of the file the edit applies to. */
  path: string;
  /** Short, raw user instruction. Truncated to 500 chars to keep the log readable. */
  instruction: string;
  selectionLen: number;
  replacementLen: number;
  model: string;
  /** Whether the edit was actually applied (true after /api/files/write). */
  applied: boolean;
  durationMs: number;
}

export function appendInlineEditAudit(entry: InlineEditAuditEntry): void {
  try {
    const auditPath = resolveAuditPath();
    const dir = path.dirname(auditPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action: 'inline-edit',
      session_id: entry.sessionId ?? null,
      user_id: entry.userId,
      role: entry.role ?? null,
      path: entry.path,
      instruction: entry.instruction.slice(0, 500),
      selection_len: entry.selectionLen,
      replacement_len: entry.replacementLen,
      model: entry.model,
      applied: entry.applied,
      duration_ms: entry.durationMs,
    });
    fs.appendFileSync(auditPath, line + '\n', 'utf-8');
  } catch (err) {
    // Audit failure should never block the request. Log and move on.
    console.error('[inline-edit/audit] failed to append:', err);
  }
}
