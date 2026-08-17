import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { watch, type FSWatcher } from 'chokidar';
import { config } from '../../config.js';

/**
 * Expand `~` and `~/...` to the backend process home directory.
 *
 * Tower invariant: on every machine the backend process owns the workspace
 * at `$HOME/workspace`, regardless of which OS user runs it (`enterpriseai`
 * on the moat-internal box, `toweradmin` on demo-org, etc.). So a path
 * emitted by the AI as `~/workspace/projects/foo/bar.md` resolves correctly
 * on every VM without the AI having to know the per-machine prefix.
 *
 * Path safety (isPathSafe / project-access guards) runs on the EXPANDED
 * path, so this does not widen access — it just lets one canonical form
 * (`~/...`) reach those checks.
 *
 * Decision: workspace/decisions/2026-05-03-path-portability.md
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function fixUnicodeFilename(name: string): string {
  // Detect double-encoded UTF-8: latin1 bytes re-encoded as UTF-8
  // e.g. multi-byte chars stored as double-encoded sequences
  if (/[\u00c0-\u00ff][\u0080-\u00bf]/.test(name)) {
    try {
      return Buffer.from(name, 'latin1').toString('utf-8').normalize('NFC');
    } catch { /* fall through */ }
  }
  return name.normalize('NFC');
}

export type { FileEntry } from '@tower/shared';
import type { FileEntry } from '@tower/shared';

// ───── Always-hidden patterns ─────
// Never shown via the file browser, even when showHidden=true. Holds:
//   - credential / audit / system state (.claude, .audit, .mcp.json, .temp-uploads, .worktrees)
//   - VCS / build noise (.git, node_modules, __pycache__, .venv, dist)
// Decision 2026-05-02-workspace-root-isolation.md — these are runtime/system
// concerns and should never leak to any role through the file APIs. (Admin can
// still touch them via direct SSH/PostgreSQL — this is the API-level guard.)
export const ALWAYS_HIDDEN = new Set([
  // Build / VCS / runtime noise
  'node_modules', '.git', '__pycache__', '.venv', 'dist',
  // Credential & system state
  '.claude', '.audit', '.mcp.json',
  '.temp-uploads', '.worktrees',
]);

// Project contracts are important, but they are not ordinary user documents.
// In the default file tree they should surface through dedicated UI such as
// “Project Instructions” / advanced project identity panels rather than as
// clutter in the user's document box. showHidden=true still reveals them for
// advanced/admin flows. Decision: project-4
// .project/decisions/2026-06-30-remove-documents-mode.md
export const DEFAULT_HIDDEN_PROJECT_CONTRACT_FILES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'SOUL.md',
  'SCAFFOLDING.md',
]);

export function isDefaultHiddenFileTreeEntry(name: string): boolean {
  return DEFAULT_HIDDEN_PROJECT_CONTRACT_FILES.has(name);
}

// ───── In-memory cache for file tree (3-second TTL) ─────
const treeCache = new Map<string, { entries: FileEntry[]; expiry: number }>();
const TREE_CACHE_TTL = 3000; // ms

export function invalidateTreeCache(dirPath?: string): void {
  if (dirPath) {
    // Invalidate exact path + parent
    treeCache.delete(dirPath);
    treeCache.delete(path.dirname(dirPath));
  } else {
    treeCache.clear();
  }
}

export function isPathSafe(targetPath: string, root?: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(root || '/');
  if (resolvedRoot === '/') return true; // root=/ means no restriction
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

export function isPathWritable(targetPath: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(config.workspaceRoot);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

export function getFileTree(dirPath: string, depth = 2, opts?: { skipSafetyCheck?: boolean; showHidden?: boolean }): FileEntry[] {
  if (!opts?.skipSafetyCheck && !isPathSafe(dirPath)) {
    throw new Error('Access denied: path outside workspace');
  }

  // Always-hidden patterns (large/noisy dirs) — never show these even with showHidden
  // alwaysHidden — never shown via the file APIs, even with showHidden=true.
  // Includes credential-bearing dirs (.claude/.audit/.mcp.json) and noise dirs
  // (node_modules/dist/.venv etc). Decision 2026-05-02-workspace-root-isolation.
  const alwaysHidden = ALWAYS_HIDDEN;

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const entries: FileEntry[] = [];

    for (const item of items) {
      if (alwaysHidden.has(item.name)) continue;
      if (!opts?.showHidden) {
        if (isDefaultHiddenFileTreeEntry(item.name) || config.hiddenPatterns.some(p => item.name === p || item.name.startsWith('.'))) {
          continue;
        }
      }

      // Fix Unicode filenames: double-encoded UTF-8 (latin1->utf8) + NFD->NFC normalize
      const displayName = fixUnicodeFilename(item.name);
      const fullPath = path.join(dirPath, item.name);
      const entry: FileEntry = {
        name: displayName,
        path: fullPath,
        isDirectory: item.isDirectory(),
      };

      try {
        const stat = fs.statSync(fullPath);
        entry.modified = stat.mtime.toISOString();
        if (!item.isDirectory()) {
          entry.size = stat.size;
          entry.extension = path.extname(item.name).slice(1);
        }
      } catch {}

      entries.push(entry);
    }

    return entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (error: any) {
    throw new Error(`Cannot read directory: ${error.message}`);
  }
}

/** Async version of getFileTree with in-memory caching (3s TTL) */
export async function getFileTreeAsync(dirPath: string, depth = 2, opts?: { skipSafetyCheck?: boolean; showHidden?: boolean }): Promise<FileEntry[]> {
  if (!opts?.skipSafetyCheck && !isPathSafe(dirPath)) {
    throw new Error('Access denied: path outside workspace');
  }

  // Check cache
  const cacheKey = `${dirPath}:${opts?.showHidden ? '1' : '0'}`;
  const cached = treeCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.entries;
  }

  // alwaysHidden — never shown via the file APIs, even with showHidden=true.
  // Includes credential-bearing dirs (.claude/.audit/.mcp.json) and noise dirs
  // (node_modules/dist/.venv etc). Decision 2026-05-02-workspace-root-isolation.
  const alwaysHidden = ALWAYS_HIDDEN;

  try {
    const items = await fsp.readdir(dirPath, { withFileTypes: true });
    const entries: FileEntry[] = [];

    // Collect entries first, batch stat calls. Directories get modified time;
    // files additionally get size. Avoid recursive directory sizing here.
    const statPromises: { entry: FileEntry; fullPath: string }[] = [];

    for (const item of items) {
      if (alwaysHidden.has(item.name)) continue;
      if (!opts?.showHidden) {
        if (isDefaultHiddenFileTreeEntry(item.name) || config.hiddenPatterns.some(p => item.name === p || item.name.startsWith('.'))) {
          continue;
        }
      }

      const displayName = fixUnicodeFilename(item.name);
      const fullPath = path.join(dirPath, item.name);
      const entry: FileEntry = {
        name: displayName,
        path: fullPath,
        isDirectory: item.isDirectory(),
      };

      if (!item.isDirectory()) {
        entry.extension = path.extname(item.name).slice(1);
      }
      statPromises.push({ entry, fullPath });

      entries.push(entry);
    }

    // Parallel stat for all visible entries
    if (statPromises.length > 0) {
      const stats = await Promise.allSettled(
        statPromises.map(({ fullPath }) => fsp.stat(fullPath))
      );
      for (let i = 0; i < stats.length; i++) {
        const result = stats[i];
        if (result.status === 'fulfilled') {
          statPromises[i].entry.modified = result.value.mtime.toISOString();
          if (!statPromises[i].entry.isDirectory) {
            statPromises[i].entry.size = result.value.size;
          }
        }
      }
    }

    const sorted = entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Store in cache
    treeCache.set(cacheKey, { entries: sorted, expiry: Date.now() + TREE_CACHE_TTL });

    return sorted;
  } catch (error: any) {
    throw new Error(`Cannot read directory: ${error.message}`);
  }
}

// Legacy Office formats (.ppt/.doc/.xls) must be listed alongside their modern
// counterparts — readFile() returns base64 for all of them so the browser can
// either preview (Office viewer converts via LibreOffice) or download as-is.
// HWP/HWPX (Korean 한글 office format) preview uses H2Orestart LibreOffice
// extension; falls back to binary download if conversion fails.
const BINARY_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'mp4', 'webm', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'hwp', 'hwpx', 'db', 'sqlite', 'sqlite3', 'dxf', 'dwg']);

export function readFile(filePath: string): { content: string; language: string; encoding?: string } {
  if (!isPathSafe(filePath)) {
    throw new Error('Access denied: path outside workspace');
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  // NOTE: Office langMap entries are mirrored in ws-handler `handleFileRead` —
  // both callers must resolve .ppt→'pptx', .doc→'docx', .xls→'xlsx' so the
  // frontend's PREVIEW_ONLY / PptxPreview branches match regardless of which
  // transport (HTTP /files/read or WS file_read) loaded the file.
  const languageMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', md: 'markdown', markdown: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
    html: 'html', htm: 'html', css: 'css', sh: 'shell', bash: 'shell',
    sql: 'sql', rs: 'rust', go: 'go', java: 'java',
    txt: 'text', rst: 'text', org: 'text', csv: 'csv', tsv: 'csv', ipynb: 'json', log: 'text',
    pdf: 'pdf',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', svg: 'image',
    mp4: 'video', webm: 'video',
    docx: 'docx', doc: 'docx',
    xlsx: 'xlsx', xls: 'xlsx',
    pptx: 'pptx', ppt: 'pptx',
    hwp: 'hwp', hwpx: 'hwp',
    db: 'sqlite', sqlite: 'sqlite', sqlite3: 'sqlite',
    dxf: 'cad', dwg: 'cad',
  };

  if (BINARY_EXTENSIONS.has(ext)) {
    const content = fs.readFileSync(filePath).toString('base64');
    return { content, language: languageMap[ext] || 'binary', encoding: 'base64' };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return { content, language: languageMap[ext] || 'text' };
}

export function writeFile(filePath: string, content: string): void {
  if (!isPathWritable(filePath)) {
    throw new Error('Access denied: path outside workspace');
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function writeFileBinary(filePath: string, buffer: Buffer, allowedRoot?: string): void {
  const resolvedTarget = path.resolve(filePath);
  const resolvedRoot = path.resolve(allowedRoot || config.workspaceRoot);
  if (!resolvedTarget.startsWith(resolvedRoot)) {
    throw new Error('Access denied: path outside workspace');
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, buffer);
}

export function createDirectory(dirPath: string): void {
  if (!isPathWritable(dirPath)) {
    throw new Error('Access denied: path outside workspace');
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

export function deleteEntry(targetPath: string): void {
  if (!isPathWritable(targetPath)) {
    throw new Error('Access denied: path outside workspace');
  }
  if (!fs.existsSync(targetPath)) {
    throw new Error('Path does not exist');
  }
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(targetPath);
  }
}

export function renameEntry(oldPath: string, newPath: string): void {
  if (!isPathWritable(oldPath)) {
    throw new Error('Access denied: source path outside workspace');
  }
  if (!isPathWritable(newPath)) {
    throw new Error('Access denied: target path outside workspace');
  }
  if (!fs.existsSync(oldPath)) {
    throw new Error('Source path does not exist');
  }
  if (fs.existsSync(newPath)) {
    throw new Error('Target path already exists');
  }
  fs.renameSync(oldPath, newPath);
}

export function copyEntry(srcPath: string, destPath: string): void {
  if (!isPathWritable(srcPath)) {
    throw new Error('Access denied: source path outside workspace');
  }
  if (!isPathWritable(destPath)) {
    throw new Error('Access denied: target path outside workspace');
  }
  if (!fs.existsSync(srcPath)) {
    throw new Error('Source path does not exist');
  }
  if (fs.existsSync(destPath)) {
    throw new Error('Target path already exists');
  }

  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.cpSync(srcPath, destPath, { recursive: true, errorOnExist: true, force: false });
  } else {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(srcPath, destPath, fs.constants.COPYFILE_EXCL);
  }
}

// ───── File Watcher (chokidar) ─────

let watcher: FSWatcher | null = null;

export type FileChangeEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
export type FileChangeCallback = (event: FileChangeEvent, filePath: string) => void;

/**
 * Debounce window for coalescing a burst of chokidar events per path.
 *
 * 2026-04-10 (100-user scale): without this, a single `git checkout` or a
 * webpack-style rebuild can fire dozens of events on the same file. Each event
 * previously fanned out to every connected WS client — with 100 clients that
 * produces thousands of messages in <100ms and blocks the event loop.
 *
 * We use a "first event starts the timer, no-reset" pattern so that a continuous
 * stream of writes still flushes every FILE_WATCHER_DEBOUNCE_MS instead of
 * starving forever (which is what clearTimeout-on-every-event would cause).
 */
const FILE_WATCHER_DEBOUNCE_MS = 150;

type PendingFileEvent = {
  event: FileChangeEvent;
  timer: NodeJS.Timeout;
};

const pendingFileEvents = new Map<string, PendingFileEvent>();

export function setupFileWatcher(rootPath: string, onChange: FileChangeCallback): void {
  if (watcher) return;

  watcher = watch(rootPath, {
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      '**/__pycache__/**',
      '**/.venv/**',
      '**/dist/**',
      '**/data/**',
      '**/.claude/**',
      '**/.claude.json*',
    ],
    depth: 3,
    ignoreInitial: true,
    persistent: true,
    // Wait until the file size is stable before emitting — prevents half-written
    // files from firing multiple `change` events during a large save.
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 100,
    },
  });

  const events: FileChangeEvent[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'];

  const scheduleEmit = (event: FileChangeEvent, filePath: string) => {
    const existing = pendingFileEvents.get(filePath);
    if (existing) {
      // A timer is already running for this path — update the latest event type
      // (so `add` → `change` → `unlink` collapses to the final state) but do NOT
      // reset the timer. This guarantees a flush every debounce window even
      // under continuous writes.
      existing.event = event;
      return;
    }

    const timer = setTimeout(() => {
      const entry = pendingFileEvents.get(filePath);
      pendingFileEvents.delete(filePath);
      if (entry) {
        try {
          onChange(entry.event, filePath);
        } catch (err) {
          console.error('[FileWatcher] onChange threw:', err);
        }
      }
    }, FILE_WATCHER_DEBOUNCE_MS);

    pendingFileEvents.set(filePath, { event, timer });
  };

  for (const event of events) {
    watcher.on(event, (filePath: string) => {
      scheduleEmit(event, filePath);
    });
  }

  watcher.on('error', (err: unknown) => {
    console.error('[FileWatcher] error:', err instanceof Error ? err.message : err);
  });

  console.log(`[FileWatcher] watching ${rootPath} (debounce ${FILE_WATCHER_DEBOUNCE_MS}ms)`);
}

export function stopFileWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
    // Drain any pending debounce timers so shutdown is clean.
    for (const { timer } of pendingFileEvents.values()) {
      clearTimeout(timer);
    }
    pendingFileEvents.clear();
    console.log('[FileWatcher] stopped');
  }
}
