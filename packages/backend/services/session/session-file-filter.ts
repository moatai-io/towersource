/**
 * session-file-filter.ts — user-facing file filter for session file panels.
 *
 * Owns: the presentational allow/deny rule for "이 세션의 파일" and its
 * project fallback list. The underlying `session_file_edits` table still keeps
 * every touched file, including code, for backlinks and commit isolation.
 *
 * Public API: isUserFacingSessionFile(filePath).
 * Decisions:
 *   - workspace/decisions/2026-05-20-session-scoped-file-tabs.md
 *   - workspace/decisions/2026-05-22-sidebar-session-files-panel.md
 */

/**
 * Extensions surfaced to users in the sidebar session files panel.
 * Whitelist: docs, data, web, images, office. Adding a new extension here is
 * intentional — if in doubt, leave it out and let users complain.
 */
const ALLOWED_EXTENSIONS = new Set<string>([
  // Documents
  'md', 'markdown', 'txt', 'rst', 'org',
  // Web
  'html', 'htm',
  // Data
  'csv', 'tsv', 'json', 'yaml', 'yml',
  // Office
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'pdf', 'hwp', 'hwpx',
  // Notebooks
  'ipynb',
  // Images
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp',
]);

/**
 * Basenames excluded even if their extension is allowed. Build/lock/config
 * files clutter the panel without being part of a user's thinking working set.
 */
const EXCLUDED_BASENAMES = new Set<string>([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml',
  'yarn.lock', 'bun.lock', 'composer.lock', 'cargo.lock',
  '.env', '.env.example', '.env.local', '.env.production', '.env.development',
  '.gitignore', '.gitattributes', '.dockerignore', '.npmrc', '.nvmrc',
]);

/**
 * Extra basename prefixes excluded (e.g. all tsconfig*.json variants).
 * Match: `tsconfig.json`, `tsconfig.backend.json`, `tsconfig.base.json`.
 */
const EXCLUDED_BASENAME_PREFIXES = ['tsconfig'];

function extOf(filePath: string): string {
  const m = filePath.match(/\.([^./\\]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function basenameOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return (slash >= 0 ? filePath.slice(slash + 1) : filePath).toLowerCase();
}

/**
 * True when a touched file should be shown in the user-facing session file
 * panel. Code files remain recorded in `session_file_edits`; this is only a UI
 * filter.
 */
export function isUserFacingSessionFile(filePath: string): boolean {
  const ext = extOf(filePath);
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  const base = basenameOf(filePath);
  if (EXCLUDED_BASENAMES.has(base)) return false;
  for (const prefix of EXCLUDED_BASENAME_PREFIXES) {
    if (base.startsWith(prefix + '.') || base === prefix) return false;
  }
  return true;
}
