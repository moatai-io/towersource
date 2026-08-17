import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

/**
 * Owns: read-only Notes View index over ordinary workspace files.
 * Public API: scanNotesIndex(rootPath, options) — folder-first document discovery.
 * See: ~/workspace/projects/tower/knowledge/notes-view-prd-v0.1.md
 */

export type NotesIndexMode = 'current' | 'all' | 'archive' | 'system';
export type NoteTitleSource = 'frontmatter' | 'h1' | 'html' | 'filename';
export type NoteTitleQuality = 'high' | 'medium' | 'low';
export type NotePathClass = 'current' | 'archive' | 'system' | 'generated' | 'other';
export type NoteKind = 'markdown' | 'pdf' | 'docx' | 'doc' | 'pptx' | 'spreadsheet' | 'html' | 'text' | 'data' | 'yaml';
export type NoteInferredType = 'guide' | 'decision' | 'research' | 'record' | 'final' | 'source' | 'system' | 'unknown';

export interface NoteItem {
  path: string;
  absolutePath: string;
  displayTitle: string;
  title: string;
  titleSource: NoteTitleSource;
  titleQuality: NoteTitleQuality;
  kind: NoteKind;
  inferredType: NoteInferredType;
  pathClass: NotePathClass;
  score: number;
  modified?: string;
  size?: number;
}

export interface NoteFolder {
  folder: string;
  label: string;
  documentCount: number;
  score: number;
  highTitleCount: number;
  items: NoteItem[];
}

export interface NotesIndexResponse {
  projectRoot: string;
  mode: NotesIndexMode;
  summary: {
    totalItems: number;
    currentItems: number;
    archiveItems: number;
    systemItems: number;
    generatedItems: number;
    otherItems: number;
    currentFolders: number;
  };
  folders: NoteFolder[];
  hiddenBuckets: {
    archive: number;
    system: number;
    generated: number;
    other: number;
  };
}

const HUMAN_EXT_SCORES: Record<string, number> = {
  '.md': 6,
  '.mdx': 6,
  '.txt': 3,
  '.pdf': 5,
  '.docx': 5,
  '.doc': 4,
  '.pptx': 4,
  '.xlsx': 3,
  '.xls': 3,
  '.csv': 2,
  '.html': 3,
  '.htm': 3,
  '.yaml': 2,
  '.yml': 2,
};

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.venv', 'venv',
]);

const SYSTEM_DIRS = new Set(['.project', '.tower', '.pi', '.runtime-box']);
const ARCHIVE_ROOTS = new Set(['experiments', 'memory', 'published', 'changelog-drafts']);
const GENERATED_PARTS = new Set(['generated', 'outputs', 'fixtures']);
const CURRENT_ROOTS = new Set(['knowledge', 'records', 'decisions', 'notes', 'reports', 'research', 'sources', 'work', 'final', 'issues', 'docs']);
const DOC_FOLDER_HINTS = new Set(['docs', 'notes', 'wiki', 'knowledge', 'research', 'records', 'final', 'reports', 'decisions', 'sources', 'work', 'guides']);
const CONFIG_NAMES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'docker-compose.yml', 'docker-compose.yaml']);
const SYSTEM_DOC_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'SOUL.md']);
const GENERIC_TITLES = new Set(['README', 'MEMORY', '[Title]', '[제목]', 'Index', 'Home', 'Untitled', '시작하기']);

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function isSkippedDirName(name: string): boolean {
  return SKIP_DIRS.has(name);
}

function kindForExt(ext: string): NoteKind | null {
  switch (ext) {
    case '.md':
    case '.mdx': return 'markdown';
    case '.txt': return 'text';
    case '.pdf': return 'pdf';
    case '.docx': return 'docx';
    case '.doc': return 'doc';
    case '.pptx': return 'pptx';
    case '.xlsx':
    case '.xls': return 'spreadsheet';
    case '.csv': return 'data';
    case '.html':
    case '.htm': return 'html';
    case '.yaml':
    case '.yml': return 'yaml';
    default: return null;
  }
}

async function readTextSample(filePath: string, limit = 80_000): Promise<string> {
  try {
    const handle = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function parseFrontmatterTitle(text: string): string | null {
  if (!text.startsWith('---')) return null;
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;
  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s*title\s*:\s*["']?(.*?)["']?\s*$/);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

function parseH1(text: string): string | null {
  for (const line of text.split('\n').slice(0, 120)) {
    const match = line.trim().match(/^#\s+(.+?)\s*#*\s*$/);
    const title = match?.[1]?.replace(/[`*_]+/g, '').trim();
    if (title) return title;
  }
  return null;
}

function parseHtmlTitle(text: string): string | null {
  for (const pattern of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const match = text.match(pattern);
    const title = match?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (title) return title;
  }
  return null;
}

function humanizeFilename(filePath: string): string {
  const parsed = path.parse(filePath);
  let stem = parsed.name
    .replace(/^\d{4}-\d{2}-\d{2}[-_ ]+/, '')
    .replace(/^\d{8}[-_ ]+/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stem) stem = parsed.base;
  if (/[가-힣]/.test(stem)) return stem;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

async function extractTitle(filePath: string, ext: string): Promise<{ title: string; titleSource: NoteTitleSource }> {
  if (ext === '.md' || ext === '.mdx') {
    const text = await readTextSample(filePath);
    const frontmatter = parseFrontmatterTitle(text);
    if (frontmatter) return { title: frontmatter, titleSource: 'frontmatter' };
    const h1 = parseH1(text);
    if (h1) return { title: h1, titleSource: 'h1' };
  }
  if (ext === '.html' || ext === '.htm') {
    const text = await readTextSample(filePath);
    const htmlTitle = parseHtmlTitle(text);
    if (htmlTitle) return { title: htmlTitle, titleSource: 'html' };
  }
  return { title: humanizeFilename(filePath), titleSource: 'filename' };
}

function classifyPath(relPath: string): NotePathClass {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.some((part) => SYSTEM_DIRS.has(part))) return 'system';
  if (parts[0] && ARCHIVE_ROOTS.has(parts[0])) return 'archive';
  if (parts.some((part) => GENERATED_PARTS.has(part))) return 'generated';
  if (parts[0] && CURRENT_ROOTS.has(parts[0])) return 'current';
  return 'other';
}

function inferType(relPath: string, title: string): NoteInferredType {
  const s = relPath.toLowerCase();
  const name = path.basename(relPath);
  if (SYSTEM_DOC_NAMES.has(name) || s.includes('/.project/')) return 'system';
  if (s.includes('decision') || s.includes('decisions') || title.includes('결정')) return 'decision';
  if (s.includes('record') || s.includes('records') || s.includes('work-log') || s.includes('progress')) return 'record';
  if (s.includes('research') || title.includes('리서치') || s.includes('analysis')) return 'research';
  if (s.includes('final') || s.includes('published')) return 'final';
  if (s.includes('guide') || s.includes('manual') || s.includes('runbook') || title.includes('가이드')) return 'guide';
  if (s.includes('source') || s.includes('sources') || s.includes('uploads')) return 'source';
  return 'unknown';
}

function titleQuality(title: string, source: NoteTitleSource): NoteTitleQuality {
  const trimmed = title.trim();
  if (GENERIC_TITLES.has(trimmed) || trimmed.length <= 3) return 'low';
  if (source === 'frontmatter' || source === 'h1' || source === 'html') return 'high';
  return 'medium';
}

function itemScore(relPath: string, ext: string, titleSource: NoteTitleSource): number {
  const parts = relPath.split('/');
  const folderParts = parts.slice(0, -1).map((p) => p.toLowerCase());
  const fileName = parts[parts.length - 1];
  let score = HUMAN_EXT_SCORES[ext] ?? 0;
  if (titleSource === 'frontmatter' || titleSource === 'h1' || titleSource === 'html') score += 3;
  if (folderParts.some((part) => DOC_FOLDER_HINTS.has(part))) score += 2;
  if (fileName && SYSTEM_DOC_NAMES.has(fileName)) score += 1;
  if (fileName && CONFIG_NAMES.has(fileName)) score -= 7;
  if (folderParts.some((part) => part === 'generated' || part === 'cache' || part === 'tmp' || part === 'temp')) score -= 3;
  if ((ext === '.yaml' || ext === '.yml' || ext === '.csv' || ext === '.html') && titleSource === 'filename') score -= 2;
  return score;
}

function includeForMode(item: NoteItem, mode: NotesIndexMode): boolean {
  if (mode === 'all') return item.pathClass !== 'system' && item.pathClass !== 'generated';
  if (mode === 'archive') return item.pathClass === 'archive';
  if (mode === 'system') return item.pathClass === 'system';
  return item.pathClass === 'current';
}

function makeDisplayTitle(itemPath: string, title: string, quality: NoteTitleQuality): string {
  if (quality === 'low') return path.basename(itemPath);
  return title;
}

export async function scanNotesIndex(
  rootPath: string,
  options: { mode?: NotesIndexMode; maxFiles?: number; maxDepth?: number } = {},
): Promise<NotesIndexResponse> {
  const projectRoot = path.resolve(rootPath);
  const mode = options.mode ?? 'current';
  const maxFiles = Math.max(50, Math.min(options.maxFiles ?? 2500, 10_000));
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 8, 20));
  const items: NoteItem[] = [];
  let seenFiles = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (seenFiles >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (seenFiles >= maxFiles) return;
      if (entry.isDirectory()) {
        // `.project` may contain small human-readable system docs, but runtime
        // materialized folders are noisy/heavy and should not be scanned for Notes.
        if (isSkippedDirName(entry.name) || entry.name === '.tower' || entry.name === '.pi' || entry.name === '.runtime-box') continue;
        await walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const absolutePath = path.join(dir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      const kind = kindForExt(ext);
      if (!kind) continue;
      seenFiles += 1;

      const relPath = toPosix(path.relative(projectRoot, absolutePath));
      const { title, titleSource } = await extractTitle(absolutePath, ext);
      const score = itemScore(relPath, ext, titleSource);
      if (score < 2) continue;
      const quality = titleQuality(title, titleSource);
      let stat: fs.Stats | null = null;
      try { stat = await fsp.stat(absolutePath); } catch {}
      const item: NoteItem = {
        path: relPath,
        absolutePath,
        displayTitle: makeDisplayTitle(relPath, title, quality),
        title,
        titleSource,
        titleQuality: quality,
        kind,
        inferredType: inferType(relPath, title),
        pathClass: classifyPath(relPath),
        score,
        modified: stat?.mtime.toISOString(),
        size: stat?.size,
      };
      items.push(item);
    }
  }

  await walk(projectRoot, 0);

  const counts = {
    totalItems: items.length,
    currentItems: items.filter((item) => item.pathClass === 'current').length,
    archiveItems: items.filter((item) => item.pathClass === 'archive').length,
    systemItems: items.filter((item) => item.pathClass === 'system').length,
    generatedItems: items.filter((item) => item.pathClass === 'generated').length,
    otherItems: items.filter((item) => item.pathClass === 'other').length,
  };

  const visibleItems = items.filter((item) => includeForMode(item, mode));
  const byFolder = new Map<string, NoteItem[]>();
  for (const item of visibleItems) {
    const folder = path.posix.dirname(item.path) === '.' ? '.' : path.posix.dirname(item.path);
    const list = byFolder.get(folder) ?? [];
    list.push(item);
    byFolder.set(folder, list);
  }

  const folders: NoteFolder[] = [...byFolder.entries()].map(([folder, folderItems]) => {
    const highTitleCount = folderItems.filter((item) => item.titleQuality === 'high').length;
    const score = folderItems.reduce((sum, item) => sum + Math.max(0, item.score), 0) + highTitleCount * 2;
    return {
      folder,
      label: folder === '.' ? path.basename(projectRoot) : path.posix.basename(folder),
      documentCount: folderItems.length,
      score,
      highTitleCount,
      items: folderItems
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }).sort((a, b) => b.score - a.score || a.folder.localeCompare(b.folder));

  return {
    projectRoot,
    mode,
    summary: {
      ...counts,
      currentFolders: folders.length,
    },
    folders,
    hiddenBuckets: {
      archive: mode === 'archive' ? 0 : counts.archiveItems,
      system: mode === 'system' ? 0 : counts.systemItems,
      generated: counts.generatedItems,
      other: mode === 'all' ? 0 : counts.otherItems,
    },
  };
}
