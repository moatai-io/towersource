/**
 * Owns: PostToolUse hook for AI sessions — auto-register published sites in
 *   manifest with project attribution, regardless of how the AI created them
 *   (mkdir + Write, hybrid symlink, /api/deploy).
 * Public API: postToolUsePublishingTracker — wired in claude-sdk.ts queryOptions.
 * See README.md and ../../../../docs/tower-guide/ai-execution-paths.md §3-2.
 */
import path from 'path';
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { registerSiteInManifest, deriveProjectFromPath, siteSlugFromPath } from './register.js';

/**
 * Pull the affected file path out of a Write/Edit/NotebookEdit tool input.
 * Returns null when the tool doesn't have a file_path field (Bash, Read, etc.)
 * — Bash command parsing is intentionally not attempted here; reconciler
 * catches sites created via shell commands within 5 minutes.
 */
function extractFilePath(_toolName: string, toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;
  // Write, Edit, NotebookEdit all use `file_path`
  const fp = input.file_path;
  if (typeof fp === 'string' && fp.length > 0) return fp;
  // Older NotebookEdit shape used `notebook_path`
  const np = input.notebook_path;
  if (typeof np === 'string' && np.length > 0) return np;
  return null;
}

/**
 * SDK PostToolUse callback. Always returns `{ continue: true }` — never blocks
 * the AI flow. Errors are caught and logged but never surfaced to the model.
 *
 * Why fire-and-forget over awaited: registerSiteInManifest is fast (~5ms for
 * a typical 30-site manifest), but a slow filesystem or write contention
 * shouldn't pause the AI. We `await` here anyway because it's already cheap
 * and keeping it sync makes failures easier to log; switch to fire-and-forget
 * (no await) only if profiling shows otherwise.
 */
export async function postToolUsePublishingTracker(
  input: HookInput,
  _toolUseID: string | undefined,
  _opts: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  try {
    if (input.hook_event_name !== 'PostToolUse') return { continue: true };
    const { tool_name, tool_input, cwd } = input;

    // Only file-writing tools — Bash etc. handled by the reconciler.
    if (!['Write', 'Edit', 'NotebookEdit'].includes(tool_name)) {
      return { continue: true };
    }

    const filePath = extractFilePath(tool_name, tool_input);
    if (!filePath) return { continue: true };

    // Resolve to absolute. file_path is usually absolute already, but normalize
    // against cwd just in case some agent passes a relative path.
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || '.', filePath);

    const slug = siteSlugFromPath(absPath);
    if (!slug) return { continue: true };

    // Prefer cwd as project signal (matches the AI's working context). Fall
    // back to the file path itself (handles `Write` that targets a hybrid
    // path while cwd is elsewhere).
    const project = deriveProjectFromPath(cwd) || deriveProjectFromPath(absPath);

    await registerSiteInManifest(slug, project);
  } catch (err: unknown) {
    // Hooks must never throw — would abort the AI turn. Log and swallow.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[publishing-hook] error: ${msg}`);
  }
  return { continue: true };
}
