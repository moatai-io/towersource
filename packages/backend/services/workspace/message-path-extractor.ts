/**
 * message-path-extractor.ts — extract workspace/tower file paths from an
 * assistant message and feed them into `session_file_edits`.
 *
 * Why this exists (2026-05-22):
 *   The per-tool PostToolUse hooks only fire for Edit / Write / NotebookEdit.
 *   Files created via Bash (`cat > foo.html`), MCP tools, external converters
 *   (wkhtmltopdf, pandoc), or any other path were invisible to the session
 *   files panel. Pi engine sessions especially relied on bash-driven artifact
 *   generation, so their working-set lists looked empty even when the session
 *   produced 9+ deliverables.
 *
 *   Solution: extract any workspace/tower absolute path mentioned in an
 *   assistant message (text or tool_use payload) and call recordFileEdit.
 *   This piggybacks on the system-prompt rule "AI must announce produced
 *   artifacts with their absolute path", which is followed near-100%.
 *
 * Coverage:
 *   - text blocks: regex match on `/home/<user>/workspace/...` or `/home/<user>/tower/...`
 *   - tool_use blocks: input.path / file_path / notebook_path (direct)
 *   - tool_use blocks: input.command (bash) regex-scanned the same way
 *
 * Tone: fire-and-forget. recordFileEdit swallows its own errors. A failed
 * extraction never breaks the message save.
 *
 * See: workspace/decisions/2026-05-20-session-scoped-file-tabs.md
 *      §"Pi engine event 경로 버그 fix — 2026-05-22"
 *      §"옵션 2 — 응답 텍스트 경로 추출 (engine-agnostic)"
 */
import { recordFileEdit } from './file-edit-log.js';

/**
 * Match `/home/<user>/(workspace|tower)/...some/path...ext`.
 *
 * Includes Korean (가-힣 + 자모 ㄱ-ㅎ / ㅏ-ㅣ) so paths like
 *   /home/tower/workspace/projects/.../영업메뉴얼_ver2.pdf
 * are captured. Extension 1–10 chars covers `.md` through `.markdown` and
 * `.ipynb`.
 *
 * Trailing punctuation (period, comma, paren, bracket, etc.) is stripped
 * by the caller — the regex itself is greedy.
 */
const ABS_PATH_RE = /\/home\/[A-Za-z0-9_-]+\/(?:workspace|tower)\/[A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ_./\-]+\.[A-Za-z0-9]{1,10}/g;

/** Strip trailing punctuation that often sticks to a path in prose. */
function cleanPath(p: string): string {
  return p.replace(/[.,;:!?)\]}>"'\s]+$/, '');
}

/**
 * Best-effort whitelist: only paths inside ~/workspace or ~/tower count.
 * The regex already enforces this — the extra check is defense in depth
 * against future regex changes.
 */
function isTrackedAbs(p: string): boolean {
  if (!p.startsWith('/home/')) return false;
  return p.includes('/workspace/') || p.includes('/tower/');
}

/** Pull workspace/tower abs paths out of a free-text string. */
function collectPathsFromText(text: string, out: Set<string>): void {
  if (!text || typeof text !== 'string') return;
  ABS_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ABS_PATH_RE.exec(text)) !== null) {
    const cleaned = cleanPath(m[0]);
    if (isTrackedAbs(cleaned)) out.add(cleaned);
  }
}

/**
 * Public API. Pull every workspace/tower absolute path mentioned in this
 * assistant message and record each as a file edit for the session.
 *
 * Idempotent at the DB layer (UNIQUE on (session_id, file_path) +
 * ON CONFLICT DO UPDATE in file-edit-log.ts). Safe to call on every save.
 *
 * @param sessionId — Tower sessions.id (UUID).
 * @param content   — message content. Either a string (legacy) or array of
 *                    `{type, text, input, ...}` blocks (Claude/Pi/Tower
 *                    canonical format).
 */
export function recordMessagePaths(sessionId: string, content: unknown): void {
  if (!sessionId) return;
  const paths = new Set<string>();

  if (typeof content === 'string') {
    collectPathsFromText(content, paths);
  } else if (Array.isArray(content)) {
    for (const blk of content) {
      if (!blk || typeof blk !== 'object') continue;
      const b = blk as Record<string, any>;

      // Text block (assistant prose)
      if (typeof b.text === 'string') {
        collectPathsFromText(b.text, paths);
      }

      // Tool use: direct path-shaped keys
      const input = b.input;
      if (input && typeof input === 'object') {
        for (const key of ['path', 'file_path', 'notebook_path']) {
          const v = (input as Record<string, any>)[key];
          if (typeof v === 'string' && isTrackedAbs(v)) {
            paths.add(cleanPath(v));
          }
        }
        // Bash command (or any string field): scan for redirects / args
        for (const v of Object.values(input as Record<string, any>)) {
          if (typeof v === 'string') {
            collectPathsFromText(v, paths);
          }
        }
      }
    }
  }

  for (const p of paths) {
    void recordFileEdit(sessionId, p, 'message-mention');
  }
}
