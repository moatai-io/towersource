import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileEntry, FileEntrySortMode } from '../../stores/file-store';
import { useFileStore } from '../../stores/file-store';
import { toastError, toastQuiet } from '../../utils/toast';
import { notifyUploadResult } from '../../utils/upload-notice';
import { readDroppedItems, uploadDroppedFiles } from '../../utils/folder-drop';
import { ShareModal } from './ShareModal';
import { MoveToFolderModal, compactTopLevelPaths } from './SelectionToolbar';
import { useConfirm } from '../../hooks/useDialog';
import { buildPdfServeUrl, isPdfPath } from '../../utils/pdf-open';
import { ViewportContextMenu } from '../common/ViewportContextMenu';

/** Recursively collect all descendant paths from a FileEntry tree */
function collectDescendantPaths(entry: FileEntry): string[] {
  const paths: string[] = [];
  if (entry.children) {
    for (const child of entry.children) {
      paths.push(child.path);
      if (child.isDirectory && child.children) {
        paths.push(...collectDescendantPaths(child));
      }
    }
  }
  return paths;
}

interface FileTreeProps {
  entries: FileEntry[];
  onFileClick: (path: string) => void;
  onDirectoryClick: (path: string) => void;
  onPinFile?: (path: string, kind?: 'file' | 'folder') => void;
  onNewSessionInFolder?: (path: string) => void;
  onRefreshTree?: (targetDir?: string) => void;
  depth?: number;
  /** Flat ordered paths for Shift range selection (provided by root only) */
  flatPaths?: string[];
}

// SVG icon components
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg className={`w-3 h-3 text-gray-500 transition-transform duration-150 max-[768px]:transition-none ${expanded ? 'rotate-90' : ''}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

type FileIconKind = 'document' | 'markdown' | 'image' | 'pdf' | 'spreadsheet' | 'web' | 'code' | 'config' | 'data' | 'notebook' | 'archive';

const iconKindsByExtension: Record<string, FileIconKind> = {
  md: 'markdown', mdx: 'markdown', txt: 'document', doc: 'document', docx: 'document', rtf: 'document', log: 'document',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', svg: 'image', gif: 'image', avif: 'image', ico: 'image',
  pdf: 'pdf',
  xlsx: 'spreadsheet', xls: 'spreadsheet', csv: 'spreadsheet', tsv: 'spreadsheet', ods: 'spreadsheet',
  html: 'web', htm: 'web', css: 'web', scss: 'web', less: 'web',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', py: 'code', sh: 'code', bash: 'code', zsh: 'code',
  rs: 'code', go: 'code', java: 'code', kt: 'code', rb: 'code', php: 'code', cs: 'code', cpp: 'code', c: 'code', h: 'code', hpp: 'code',
  json: 'config', yaml: 'config', yml: 'config', toml: 'config', env: 'config', ini: 'config', conf: 'config', lock: 'config',
  sql: 'data', xml: 'data', dxf: 'data', dwg: 'data',
  ipynb: 'notebook',
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', rar: 'archive', '7z': 'archive',
};

const iconKindsByName: Record<string, FileIconKind> = {
  dockerfile: 'config',
  'dockerfile.fast': 'config',
  'package.json': 'config',
  'package-lock.json': 'config',
  'pnpm-lock.yaml': 'config',
  'yarn.lock': 'config',
  'uv.lock': 'config',
  '.gitignore': 'config',
  '.env': 'config',
  '.env.example': 'config',
  readme: 'markdown',
  'readme.md': 'markdown',
  agents: 'markdown',
  'agents.md': 'markdown',
  claude: 'markdown',
  'claude.md': 'markdown',
};

const fileIconColorClasses = {
  document: 'text-surface-400',
  markdown: 'text-sky-400',
  image: 'text-emerald-400',
  pdf: 'text-red-400',
  spreadsheet: 'text-green-400',
  web: 'text-orange-400',
  code: 'text-blue-400',
  config: 'text-violet-400',
  data: 'text-purple-400',
  notebook: 'text-amber-400',
  archive: 'text-yellow-400',
} satisfies Record<FileIconKind, string>;

function getFileIconKind(name?: string, extension?: string): FileIconKind {
  const normalizedName = (name || '').toLowerCase();
  const normalizedExt = (extension || normalizedName.split('.').pop() || '').toLowerCase();
  return iconKindsByName[normalizedName] || iconKindsByExtension[normalizedExt] || 'document';
}

function FileIconGlyph({ kind }: { kind: FileIconKind }) {
  if (kind === 'image') {
    return (
      <g className="stroke-white/90" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.15">
        <circle cx="8.2" cy="8" r=".8" className="fill-white/90 stroke-none" />
        <path d="M6.25 12.1l2.05-2.05 1.45 1.45 1.1-1.1 2.4 1.7" />
      </g>
    );
  }
  if (kind === 'spreadsheet') {
    return <path className="stroke-white/90" d="M6.45 7.7h6.1M6.45 9.8h6.1M6.45 11.9h6.1M9.15 6.7v6.15" fill="none" strokeLinecap="round" strokeWidth=".95" />;
  }
  if (kind === 'code' || kind === 'web') {
    return <path className="stroke-white/90" d="M8.35 8.1L6.6 9.85l1.75 1.75M11.65 8.1l1.75 1.75-1.75 1.75" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.15" />;
  }
  if (kind === 'config') {
    return (
      <g className="stroke-white/90" fill="none" strokeLinecap="round" strokeWidth="1">
        <path d="M7.1 8.05h5.8M7.1 10h5.8M7.1 11.95h3.25" />
        <circle cx="12.35" cy="12" r=".75" className="fill-white/90 stroke-none" />
      </g>
    );
  }
  if (kind === 'data') {
    return (
      <g className="stroke-white/90" fill="none" strokeWidth="1" strokeLinejoin="round">
        <ellipse cx="10" cy="7.65" rx="2.65" ry="1" />
        <path d="M7.35 7.65v4.3c0 .55 1.18 1 2.65 1s2.65-.45 2.65-1v-4.3M7.35 9.8c0 .55 1.18 1 2.65 1s2.65-.45 2.65-1" />
      </g>
    );
  }
  if (kind === 'notebook') {
    return (
      <g>
        <rect x="6.7" y="7" width="6.3" height="1.35" rx=".45" className="fill-white/90" />
        <rect x="6.7" y="9.35" width="4.7" height="1.35" rx=".45" className="fill-white/75" />
        <rect x="6.7" y="11.7" width="5.7" height="1.35" rx=".45" className="fill-white/75" />
      </g>
    );
  }
  if (kind === 'archive') {
    return <path className="stroke-white/90" d="M9.35 6.7h1.3M9.35 8.15h1.3M9.35 9.6h1.3M9.35 11.05h1.3M10 12.1v1" fill="none" strokeLinecap="round" strokeWidth="1" />;
  }
  if (kind === 'pdf') {
    return <text x="10" y="11.8" textAnchor="middle" className="fill-white font-bold" fontSize="3.6" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">PDF</text>;
  }
  if (kind === 'markdown') {
    return <text x="10" y="11.8" textAnchor="middle" className="fill-white font-bold" fontSize="4" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">MD</text>;
  }
  return <path className="stroke-white/85" d="M7.05 8.15h5.8M7.05 10.15h5.3M7.05 12.15h3.8" fill="none" strokeLinecap="round" strokeWidth="1" />;
}

function FileIcon({ name, extension }: { name?: string; extension?: string }) {
  const kind = getFileIconKind(name, extension);
  const colorClass = fileIconColorClasses[kind];

  return (
    <svg className={`w-4 h-4 shrink-0 ${colorClass} drop-shadow-[0_1px_1px_rgba(0,0,0,0.28)]`} viewBox="0 0 20 20" aria-hidden="true">
      <path className="fill-current" d="M5.25 2.35h6.55l3.45 3.45v10.45c0 .77-.63 1.4-1.4 1.4h-8.6c-.77 0-1.4-.63-1.4-1.4V3.75c0-.77.63-1.4 1.4-1.4z" />
      <path className="fill-white/28" d="M11.7 2.6v3.05c0 .38.3.68.68.68h2.62L11.7 2.6z" />
      <path className="stroke-black/10" d="M5.25 2.35h6.55l3.45 3.45v10.45c0 .77-.63 1.4-1.4 1.4h-8.6c-.77 0-1.4-.63-1.4-1.4V3.75c0-.77.63-1.4 1.4-1.4z" fill="none" strokeWidth=".7" />
      <path className="fill-white/20" d="M5.35 3.2h5.35v1.2H5.35z" />
      <FileIconGlyph kind={kind} />
    </svg>
  );
}


function LoadingSpinner() {
  return (
    <svg className="w-3 h-3 text-primary-400 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function CheckIcon({ checked }: { checked: boolean }) {
  return (
    <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-all ${
      checked
        ? 'bg-primary-500 border-primary-500'
        : 'border-surface-600 hover:border-primary-500/50'
    }`}>
      {checked && (
        <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      )}
    </div>
  );
}

// 핀 가능한 확장자 화이트리스트.
// 의도: 사용자가 "이 파일은 왜 안 핀돼?" 라고 묻는 마찰을 없애기 위해 흔한 문서/
// 이미지/설정/사이트 자산 폭넓게 허용. 실행 binary (exe/so/dylib) 류만 자연 제외.
// html 은 published 사이트 (workspace/published/sites/<slug>/index.html) 도 커버.
const pinnableExtensions = new Set([
  // 문서·코드 (기존)
  'md', 'html', 'htm', 'txt', 'py', 'ts', 'tsx', 'js', 'jsx', 'json',
  // 오피스·PDF·CAD
  'pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'csv', 'tsv', 'dxf', 'dwg',
  // 데이터·설정
  'yaml', 'yml', 'toml', 'sql', 'env', 'ini', 'conf', 'log', 'xml',
  // 이미지
  'png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'avif',
  // 사이트·스타일·노트북
  'css', 'scss', 'less', 'ipynb', 'mjs', 'cjs',
  // 셸·도커·인프라
  'sh', 'bash', 'zsh', 'dockerfile', 'tf', 'hcl',
  // 기타 코드
  'rs', 'go', 'java', 'kt', 'rb', 'php', 'cs', 'cpp', 'c', 'h', 'hpp',
]);

// ─── API helpers ───
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function apiPost(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function parseTime(raw?: string): number {
  if (!raw) return 0;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const t = new Date(normalized).getTime();
  return Number.isFinite(t) ? t : 0;
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortEntriesForDisplay(entries: FileEntry[], mode: FileEntrySortMode): FileEntry[] {
  const sorted = [...entries].sort((a, b) => {
    const dirDelta = Number(b.isDirectory) - Number(a.isDirectory);
    if (mode === 'folders-name' && dirDelta !== 0) return dirDelta;
    if (mode === 'modified') {
      const modifiedDelta = parseTime(b.modified) - parseTime(a.modified);
      if (modifiedDelta !== 0) return modifiedDelta;
      if (dirDelta !== 0) return dirDelta;
      return naturalCollator.compare(a.name, b.name);
    }
    if (mode === 'type') {
      const aType = a.isDirectory ? '0-folder' : (a.extension || 'zz');
      const bType = b.isDirectory ? '0-folder' : (b.extension || 'zz');
      const typeDelta = naturalCollator.compare(aType, bType);
      if (typeDelta !== 0) return typeDelta;
      return naturalCollator.compare(a.name, b.name);
    }
    return naturalCollator.compare(a.name, b.name);
  });
  return sorted.map((entry) => entry.children ? { ...entry, children: sortEntriesForDisplay(entry.children, mode) } : entry);
}

/** Flatten tree entries to ordered path list (for Shift range selection) */
export function flattenEntries(entries: FileEntry[]): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    result.push(entry.path);
    if (entry.isDirectory && entry.isExpanded && entry.children) {
      result.push(...flattenEntries(entry.children));
    }
  }
  return result;
}

type FolderDropTargetVariant = 'row' | 'contents';

/** Drop target for a folder row or the open area inside an expanded folder. */
function FolderDropTarget({ entry, children, onRefreshTree, variant = 'row' }: {
  entry: FileEntry;
  children: React.ReactNode;
  onRefreshTree?: (targetDir?: string) => void;
  variant?: FolderDropTargetVariant;
}) {
  const { t } = useTranslation('files');
  const confirm = useConfirm();
  const [dragOver, setDragOver] = useState(false);
  const [dropType, setDropType] = useState<'move' | 'upload' | null>(null);

  if (!entry.isDirectory) return <div className="group flex items-center min-h-[22px]">{children}</div>;

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    setDropType(null);

    // 1) Internal item move (folder or file)
    const moveData = e.dataTransfer.getData('application/x-filetree-move');
    if (moveData) {
      try {
        const parsed = JSON.parse(moveData);
        const srcPath: string = parsed.path;
        const srcName: string = parsed.name;
        const destPath = `${entry.path}/${srcName}`;

        // Prevent moving into itself
        if (srcPath === entry.path) return;
        // Prevent circular move (parent into its own child)
        if (entry.path.startsWith(srcPath + '/')) {
          toastError('Cannot move a folder into its own subfolder');
          return;
        }
        // Already in same location
        if (srcPath === destPath) return;

        const ok = await confirm({
          title: t('moveToFolder'),
          message: t('confirmMoveItemToFolder', { item: srcName, folder: entry.name }),
          confirmLabel: t('move'),
        });
        if (!ok) return;

        await apiPost('/api/files/rename', { oldPath: srcPath, newPath: destPath });
        toastQuiet(`Moved "${srcName}" to ${entry.name}/`);
        onRefreshTree?.();
      } catch (err: any) {
        toastError(err.message || 'Move failed');
      }
      return;
    }

    // 2) Existing: external file/folder upload
    void uploadFilesToDir(entry.path, e, onRefreshTree);
  };

  const activeClass = dragOver
    ? dropType === 'move'
      ? 'bg-blue-900/30 ring-1 ring-blue-500/40 rounded'
      : 'bg-primary-900/30 ring-1 ring-primary-500/40 rounded'
    : '';
  const baseClass = variant === 'row'
    ? 'group flex items-center min-h-[22px]'
    : 'rounded-sm transition-colors';

  return (
    <div
      className={`${baseClass} ${activeClass}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('application/x-filetree-move')) {
          e.dataTransfer.dropEffect = 'move';
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const isMove = e.dataTransfer.types.includes('application/x-filetree-move');
        setDropType(isMove ? 'move' : 'upload');
        setDragOver(true);
      }}
      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) { setDragOver(false); setDropType(null); } }}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
}

/** Upload files (and folders, preserving structure) to a directory via drag & drop */
async function uploadFilesToDir(targetDir: string, e: React.DragEvent, onRefreshTree?: (targetDir?: string) => void) {
  // Skip internal drags
  if (e.dataTransfer.getData('application/x-attachment')) return;

  let items;
  try {
    items = await readDroppedItems(e.dataTransfer);
  } catch (err) {
    console.error('[filetree] Failed to read dropped items:', err);
    toastError('Failed to read dropped folder');
    return;
  }
  if (items.length === 0) return;

  const targetName = targetDir.split('/').pop();

  try {
    const { ok, fail } = await uploadDroppedFiles(targetDir, items);
    notifyUploadResult({ ok, fail }, targetName ? `${targetName}/` : undefined);
    if (ok > 0) onRefreshTree?.(targetDir);
  } catch (err) {
    console.error('[filetree] File upload error:', err);
    toastError(`Upload failed: ${err instanceof Error ? err.message : 'Network error'}`);
  }
}

// ─── Context Menu ───
type MenuAction = 'newFile' | 'newFolder' | 'uploadHere' | 'paste' | 'moveSelected' | 'rename' | 'delete' | 'newSession' | 'shareFile' | 'download' | 'downloadZip' | 'copyPath' | 'openNewWindow' | 'pin';

function ContextMenu({ x, y, entry, showNewSession, canPin, canPaste, clipboardCount, selectedCount, isSelectedContext, onAction, onClose, mobile = false }: {
  x: number; y: number; entry: FileEntry;
  showNewSession: boolean;
  canPin: boolean;
  canPaste: boolean;
  clipboardCount: number;
  selectedCount: number;
  isSelectedContext: boolean;
  onAction: (action: MenuAction, entry: FileEntry) => void;
  onClose: () => void;
  mobile?: boolean;
}) {
  const { t } = useTranslation('files');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [onClose]);

  const menuItems: { action: MenuAction; label: string; icon: React.ReactNode; show: boolean; danger?: boolean }[] = [
    {
      action: 'uploadHere', label: t('uploadFilesHere'), show: entry.isDirectory,
      icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>,
    },
    {
      action: 'newFile', label: t('newFile'), show: entry.isDirectory,
      icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
    },
    {
      action: 'newFolder', label: t('newFolder'), show: entry.isDirectory,
      icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>,
    },
    {
      action: 'newSession', label: t('newSessionHere'), show: entry.isDirectory && showNewSession,
      icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>,
    },
    {
      action: 'paste', label: clipboardCount > 1 ? `Paste ${clipboardCount} items here` : 'Paste here', show: entry.isDirectory && canPaste,
      icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2m-4 0a2 2 0 104 0m-4 0a2 2 0 114 0m-6 8h6m-6 4h6" /></svg>,
    },
    {
      action: 'moveSelected', label: selectedCount > 1 ? `Move ${selectedCount} items...` : 'Move to folder...', show: isSelectedContext,
      icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>,
    },
    {
      action: 'pin' as MenuAction,
      label: t('addToFavorites'),
      show: canPin,
      icon: (
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16 3.5v5.1l2.3 2.3c.45.45.13 1.2-.5 1.2h-4.55v7.15a.75.75 0 01-1.5 0V12.1H7.2c-.63 0-.95-.75-.5-1.2L9 8.6V3.5H7.75a.75.75 0 010-1.5h8.5a.75.75 0 010 1.5H16z" />
        </svg>
      ),
    },
    {
      action: 'openNewWindow' as MenuAction,
      label: t('openInNewWindow'),
      show: !entry.isDirectory && !isSelectedContext,
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      ),
    },
    {
      action: 'shareFile' as MenuAction,
      label: 'Share',
      show: !entry.isDirectory && !isSelectedContext,
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      ),
    },
    {
      action: 'download' as MenuAction,
      label: 'Download',
      show: !entry.isDirectory && !isSelectedContext,
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      ),
    },
    {
      action: 'downloadZip' as MenuAction,
      label: isSelectedContext ? `Download ${selectedCount} as ZIP` : 'Download as ZIP',
      show: entry.isDirectory || isSelectedContext,
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      ),
    },
    {
      action: 'copyPath', label: isSelectedContext ? `Copy ${selectedCount} paths` : 'Copy path', show: true,
      icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>,
    },
    {
      action: 'rename', label: 'Rename', show: !isSelectedContext,
      icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
    },
    {
      action: 'delete', label: isSelectedContext ? `Delete ${selectedCount} items` : 'Delete', show: true, danger: true,
      icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    },
  ];

  const menuContent = (
    <>
      {menuItems.filter(m => m.show).map((item, i) => (
        <React.Fragment key={item.action}>
          {item.danger && i > 0 && <div className="border-t border-surface-700/50 my-0.5" />}
          <button
            className={`w-full min-h-[44px] flex items-center gap-3 px-4 py-2 text-[15px] text-left transition-colors ${
              item.danger
                ? 'text-red-400 hover:bg-red-600/20 hover:text-red-300'
                : 'text-gray-300 hover:bg-primary-600/30 hover:text-white'
            }`}
            onClick={() => { onAction(item.action, entry); onClose(); }}
          >
            <span className={item.danger ? 'text-red-400' : 'text-primary-400'}>{item.icon}</span>
            {item.label}
          </button>
        </React.Fragment>
      ))}
      <div className="px-4 py-2 text-[13px] text-gray-500 truncate border-t border-surface-700/50 mt-0.5 pt-1">
        {entry.name}
      </div>
    </>
  );

  if (mobile) return (
    <>
      <div className="fixed inset-0 z-40 bg-black/25" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom,0px)+0.5rem)] z-50 max-h-[82vh] overflow-y-auto overscroll-contain bg-surface-800 border border-surface-700 rounded-2xl shadow-2xl py-2" onClick={(e) => e.stopPropagation()}>
        {menuContent}
      </div>
    </>
  );

  return (
    <ViewportContextMenu
      x={x}
      y={y}
      className="fixed z-50 max-h-[calc(100vh-1rem)] overflow-y-auto bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-[180px]"
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={ref}>{menuContent}</div>
    </ViewportContextMenu>
  );
}

// ─── Inline name input ───
function InlineInput({ defaultValue, placeholder, onSubmit, onCancel }: {
  defaultValue?: string; placeholder: string;
  onSubmit: (value: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue || '');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    if (defaultValue) ref.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const trimmed = value.trim();
      if (trimmed) onSubmit(trimmed);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={onCancel}
      placeholder={placeholder}
      className="w-full bg-surface-950 border border-primary-500/50 rounded px-2 py-0.5 text-[14px] text-gray-200 outline-none"
    />
  );
}

export function FileTree({ entries, onFileClick, onDirectoryClick, onPinFile, onNewSessionInFolder, onRefreshTree, depth = 0, flatPaths: parentFlatPaths }: FileTreeProps) {
  const { t } = useTranslation('layout');
  const { t: tFiles } = useTranslation('files');
  const confirm = useConfirm();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry; presentation: 'pointer' | 'sheet' } | null>(null);
  const [inlineInput, setInlineInput] = useState<{ type: 'newFile' | 'newFolder' | 'rename'; parentPath?: string; entry?: FileEntry } | null>(null);
  const [shareFilePath, setShareFilePath] = useState<string | null>(null);
  const [moveModalPaths, setMoveModalPaths] = useState<string[] | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const folderUploadTargetRef = useRef<string | null>(null);
  const isTouchDevice = useRef(typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
  const fileSortMode = useFileStore((s) => s.fileSortMode);
  const sortedEntries = useMemo(() => sortEntriesForDisplay(entries, fileSortMode), [entries, fileSortMode]);

  // Multi-select state from store
  const selectMode = useFileStore((s) => s.selectMode);
  const selectedPaths = useFileStore((s) => s.selectedPaths);
  const fileClipboard = useFileStore((s) => s.fileClipboard);
  const toggleSelectPath = useFileStore((s) => s.toggleSelectPath);
  const bulkTogglePaths = useFileStore((s) => s.bulkTogglePaths);
  const rangeSelectTo = useFileStore((s) => s.rangeSelectTo);
  const setLastClickedPath = useFileStore((s) => s.setLastClickedPath);

  // Build flat paths list at root level for Shift range selection
  const flatPaths = useMemo(() => {
    if (depth === 0) return flattenEntries(sortedEntries);
    return parentFlatPaths || [];
  }, [sortedEntries, depth, parentFlatPaths]);

  // Escape key exits select mode (root level only)
  useEffect(() => {
    if (depth !== 0 || !selectMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        useFileStore.getState().toggleSelectMode();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [depth, selectMode]);

  const openContextFromButton = useCallback((entry: FileEntry, e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.right, y: rect.bottom, entry, presentation: 'sheet' });
  }, []);

  const handleEntryClick = useCallback((entry: FileEntry, e: React.MouseEvent) => {
    if (selectMode) {
      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey) {
        // Shift+Click → range select
        rangeSelectTo(entry.path, flatPaths);
      } else {
        // Normal click or Ctrl+Click in select mode → toggle
        toggleSelectPath(entry.path);
      }
      return;
    }

    // Not in select mode: check Ctrl/Meta for ad-hoc multi-select
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      // Enter select mode implicitly
      useFileStore.getState().toggleSelectMode();
      toggleSelectPath(entry.path);
      return;
    }

    // Normal click
    if (entry.isDirectory) {
      onDirectoryClick(entry.path);
    } else if (isPdfPath(entry.path)) {
      window.open(buildPdfServeUrl(entry.path), '_blank', 'noopener,noreferrer');
    } else {
      onFileClick(entry.path);
    }
    setLastClickedPath(entry.path);
  }, [selectMode, flatPaths, onDirectoryClick, onFileClick, toggleSelectPath, rangeSelectTo, setLastClickedPath]);

  const getActionPaths = (entry: FileEntry) => {
    if (selectedPaths.has(entry.path) && selectedPaths.size > 0) {
      return compactTopLevelPaths([...selectedPaths]);
    }
    return [entry.path];
  };

  const handleContextAction = async (action: MenuAction, entry: FileEntry) => {
    const actionPaths = getActionPaths(entry);
    const isBulkAction = actionPaths.length > 1 || (selectedPaths.has(entry.path) && selectedPaths.size > 1);

    if (action === 'newSession' && onNewSessionInFolder) {
      onNewSessionInFolder(entry.path);
      return;
    }

    if (action === 'newFile') {
      if (!entry.isExpanded) onDirectoryClick(entry.path);
      setInlineInput({ type: 'newFile', parentPath: entry.path });
      return;
    }

    if (action === 'newFolder') {
      if (!entry.isExpanded) onDirectoryClick(entry.path);
      setInlineInput({ type: 'newFolder', parentPath: entry.path });
      return;
    }

    if (action === 'uploadHere') {
      if (!entry.isDirectory) return;
      folderUploadTargetRef.current = entry.path;
      folderUploadInputRef.current?.click();
      return;
    }

    if (action === 'paste') {
      if (!entry.isDirectory || !fileClipboard?.paths.length) return;
      try {
        const result = await apiPost('/api/files/copy', { paths: fileClipboard.paths, targetDir: entry.path });
        if (result.copied > 0) toastQuiet(tFiles('tree.pasted', { count: result.copied }));
        if (result.failed > 0) toastError(tFiles('tree.pasteFailed', { count: result.failed }));
        onRefreshTree?.();
      } catch (err: any) {
        toastError(err.message || 'Paste failed');
      }
      return;
    }

    if (action === 'moveSelected') {
      setMoveModalPaths(actionPaths);
      return;
    }

    if (action === 'rename') {
      setInlineInput({ type: 'rename', entry });
      return;
    }

    if (action === 'pin') {
      onPinFile?.(entry.path, entry.isDirectory ? 'folder' : 'file');
      return;
    }

    if (action === 'openNewWindow') {
      const url = isPdfPath(entry.path)
        ? buildPdfServeUrl(entry.path)
        : `/file-viewer?path=${encodeURIComponent(entry.path)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }

    if (action === 'shareFile') {
      setShareFilePath(entry.path);
      return;
    }

    if (action === 'copyPath') {
      try {
        await navigator.clipboard.writeText(actionPaths.join('\n'));
        toastQuiet(isBulkAction ? `${actionPaths.length} paths copied` : 'Path copied');
      } catch {
        toastError('Failed to copy path');
      }
      return;
    }

    if (action === 'download') {
      // Native browser download — streams large videos/files without buffering the
      // whole Blob in the renderer process before the save begins.
      const token = localStorage.getItem('token');
      const url = `/api/files/serve?path=${encodeURIComponent(entry.path)}&download=1${token ? `&token=${encodeURIComponent(token)}` : ''}`;
      window.open(url, '_blank');
      return;
    }

    if (action === 'downloadZip') {
      // Use window.open for native browser download — handles large files without fetch buffering
      const token = localStorage.getItem('token');
      if (isBulkAction || selectedPaths.has(entry.path)) {
        const params = new URLSearchParams();
        params.set('paths', JSON.stringify(actionPaths));
        if (token) params.set('token', token);
        window.open(`/api/files/download-zip-selected?${params.toString()}`, '_blank');
      } else {
        const url = `/api/files/download-zip?path=${encodeURIComponent(entry.path)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
        window.open(url, '_blank');
      }
      return;
    }

    if (action === 'delete') {
      const displayName = entry.name;
      const isDir = entry.isDirectory;
      const ok = await confirm({
        title: 'Delete',
        message: isBulkAction
          ? `Delete ${actionPaths.length} selected items?`
          : `Delete "${displayName}"${isDir ? ' and all its contents' : ''}?`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        let success = 0;
        let fail = 0;
        for (const path of actionPaths) {
          try {
            await apiPost('/api/files/delete', { path });
            success++;
          } catch {
            fail++;
          }
        }
        if (success > 0) toastQuiet(isBulkAction ? tFiles('tree.deleted', { count: success }) : tFiles('tree.deletedOne', { name: displayName }));
        if (fail > 0) toastError(tFiles('tree.deleteFailed', { count: fail }));
        useFileStore.getState().clearSelection();
        onRefreshTree?.();
      } catch (err: any) {
        toastError(err.message || 'Delete failed');
      }
    }
  };

  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const targetDir = folderUploadTargetRef.current;
    if (!files || files.length === 0 || !targetDir) return;

    const items = Array.from(files).map((file) => ({ file, relativePath: file.name }));
    const targetName = targetDir.split('/').pop() || targetDir;
    try {
      const { ok, fail } = await uploadDroppedFiles(targetDir, items);
      notifyUploadResult({ ok, fail }, `${targetName}/`);
      if (ok > 0) {
        useFileStore.getState().bumpRefreshTrigger();
        onRefreshTree?.(targetDir);
      }
    } catch (err) {
      toastError(`Upload failed: ${err instanceof Error ? err.message : 'Network error'}`);
    } finally {
      e.target.value = '';
      folderUploadTargetRef.current = null;
    }
  };

  const handleInlineSubmit = async (value: string) => {
    if (!inlineInput) return;

    try {
      if (inlineInput.type === 'newFile' && inlineInput.parentPath) {
        const filePath = `${inlineInput.parentPath}/${value}`;
        await apiPost('/api/files/create', { path: filePath, content: '' });
        toastQuiet(`${value} created`);
      } else if (inlineInput.type === 'newFolder' && inlineInput.parentPath) {
        const dirPath = `${inlineInput.parentPath}/${value}`;
        await apiPost('/api/files/mkdir', { path: dirPath });
        toastQuiet(`${value} folder created`);
      } else if (inlineInput.type === 'rename' && inlineInput.entry) {
        const oldPath = inlineInput.entry.path;
        const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/'));
        const newPath = `${parentDir}/${value}`;
        await apiPost('/api/files/rename', { oldPath, newPath });
        toastQuiet(`Renamed`);
      }
      onRefreshTree?.();
    } catch (err: any) {
      toastError(err.message || 'Operation failed');
    }
    setInlineInput(null);
  };

  return (
    <div>
      <input ref={folderUploadInputRef} type="file" multiple hidden onChange={handleFolderUpload} />
      {sortedEntries.map((entry) => {
        const isSelected = selectedPaths.has(entry.path);

        return (
          <div key={entry.path} data-sidebar-file-path={entry.path} onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, entry, presentation: 'pointer' });
          }}>
            {/* Rename inline input */}
            {inlineInput?.type === 'rename' && inlineInput.entry?.path === entry.path ? (
              <div className="px-2 py-0.5">
                <InlineInput
                  defaultValue={entry.name}
                  placeholder={t('newNamePlaceholder')}
                  onSubmit={handleInlineSubmit}
                  onCancel={() => setInlineInput(null)}
                />
              </div>
            ) : (
              <FolderDropTarget entry={entry} onRefreshTree={onRefreshTree}>
                {/* Select mode checkbox */}
                {selectMode && (
                  <button
                    className="pl-1 pr-0.5 py-0.5 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.shiftKey) {
                        rangeSelectTo(entry.path, flatPaths);
                      } else if (entry.isDirectory) {
                        // Toggle folder + all descendants
                        const willSelect = !isSelected;
                        const allPaths = [entry.path, ...collectDescendantPaths(entry)];
                        bulkTogglePaths(allPaths, willSelect);
                      } else {
                        toggleSelectPath(entry.path);
                      }
                    }}
                  >
                    <CheckIcon checked={isSelected} />
                  </button>
                )}
                <div
                  role="button"
                  className={`flex-1 ${isTouchDevice.current ? 'min-h-[28px]' : 'h-[22px]'} flex items-center gap-1.5 px-2 py-0 text-[14px] leading-none text-gray-300 rounded transition-colors cursor-default select-none ${
                    draggingPath === entry.path
                      ? 'opacity-40'
                      : isSelected && selectMode
                        ? 'bg-primary-600/20 text-white'
                        : 'hover:bg-surface-800'
                  }`}
                  onClick={(e) => handleEntryClick(entry, e)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, entry, presentation: 'pointer' });
                  }}
                  draggable={!isTouchDevice.current}
                  style={isTouchDevice.current ? { touchAction: 'pan-y' } : undefined}
                  onDragEnd={() => setDraggingPath(null)}
                  onDragStart={(e) => {
                    setDraggingPath(entry.path);
                    if (entry.isDirectory) {
                      // Folder move via custom MIME type (distinct from file upload drops)
                      e.dataTransfer.setData('application/x-filetree-move', JSON.stringify({
                        type: 'directory',
                        path: entry.path,
                        name: entry.name,
                      }));
                      e.dataTransfer.effectAllowed = 'move';
                    } else {
                      // Existing: drag file to chat as attachment
                      e.dataTransfer.setData('application/x-attachment', JSON.stringify({
                        type: 'file',
                        label: entry.name,
                        content: entry.path,
                      }));
                      // Also allow file move between folders via D&D
                      e.dataTransfer.setData('application/x-filetree-move', JSON.stringify({
                        type: 'file',
                        path: entry.path,
                        name: entry.name,
                      }));
                      e.dataTransfer.effectAllowed = 'copyMove';
                    }
                  }}
                >
                  {entry.isDirectory ? (
                    <span
                      className={selectMode ? 'cursor-pointer hover:text-white' : ''}
                      onClick={selectMode ? (e) => { e.stopPropagation(); onDirectoryClick(entry.path); } : undefined}
                    >
                      {entry.isLoading ? <LoadingSpinner /> : <ChevronIcon expanded={!!entry.isExpanded} />}
                    </span>
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  {!entry.isDirectory && <FileIcon name={entry.name} extension={entry.extension} />}
                  <span className={`truncate ${entry.isDirectory ? 'font-medium text-gray-200' : 'text-gray-400'}`}>{entry.name}</span>
                  {entry.size !== undefined && !entry.isDirectory && (
                    <span className="ml-auto text-[12px] text-gray-500">
                      {entry.size < 1024 ? `${entry.size}B` : `${(entry.size / 1024).toFixed(1)}K`}
                    </span>
                  )}
                </div>
                {!selectMode && isTouchDevice.current && (
                  <button
                    onClick={(e) => openContextFromButton(entry, e)}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-surface-500 active:bg-surface-750 active:text-surface-100"
                    title={t('fileActions', { ns: 'files' })}
                    aria-label={t('fileActions', { ns: 'files' })}
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.8" />
                      <circle cx="12" cy="12" r="1.8" />
                      <circle cx="19" cy="12" r="1.8" />
                    </svg>
                  </button>
                )}
                {/* Pinning remains available from the context menu. Keeping it off
                    the row prevents a low-frequency action from following the pointer. */}
              </FolderDropTarget>
            )}
            {/* Children + inline new file/folder inputs inside expanded dir */}
            {entry.isDirectory && entry.isExpanded && (
              <FolderDropTarget entry={entry} onRefreshTree={onRefreshTree} variant="contents">
                <div className={isTouchDevice.current ? 'ml-1 pl-2 border-l border-surface-700/30' : 'ml-1.5 pl-2 border-l border-surface-700/25'}>
                  {/* Inline new file / new folder input */}
                  {inlineInput && (inlineInput.type === 'newFile' || inlineInput.type === 'newFolder') && inlineInput.parentPath === entry.path && (
                    <div className="flex items-center gap-1.5 px-2 py-0.5">
                      {inlineInput.type === 'newFolder' ? (
                        <span className="w-4 h-4 shrink-0" />
                      ) : (
                        <FileIcon />
                      )}
                      <InlineInput
                        placeholder={inlineInput.type === 'newFile' ? t('fileNameShort') : t('folderNameShort')}
                        onSubmit={handleInlineSubmit}
                        onCancel={() => setInlineInput(null)}
                      />
                    </div>
                  )}
                  {entry.children && (
                    <FileTree
                      entries={entry.children}
                      onFileClick={onFileClick}
                      onDirectoryClick={onDirectoryClick}
                      onPinFile={onPinFile}
                      onNewSessionInFolder={onNewSessionInFolder}
                      onRefreshTree={onRefreshTree}
                      depth={depth + 1}
                      flatPaths={flatPaths}
                    />
                  )}
                </div>
              </FolderDropTarget>
            )}
          </div>
        );
      })}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y} entry={contextMenu.entry}
          showNewSession={!!onNewSessionInFolder}
          canPin={!selectedPaths.has(contextMenu.entry.path) && !!onPinFile && (contextMenu.entry.isDirectory || pinnableExtensions.has(contextMenu.entry.extension || ''))}
          canPaste={!!fileClipboard?.paths.length}
          clipboardCount={fileClipboard?.paths.length || 0}
          selectedCount={getActionPaths(contextMenu.entry).length}
          isSelectedContext={selectedPaths.has(contextMenu.entry.path)}
          onAction={handleContextAction}
          onClose={() => setContextMenu(null)}
          mobile={contextMenu.presentation === 'sheet'}
        />
      )}
      {shareFilePath && (
        <ShareModal filePath={shareFilePath} onClose={() => setShareFilePath(null)} />
      )}
      {moveModalPaths && (
        <MoveToFolderModal
          selectedPaths={moveModalPaths}
          onClose={() => setMoveModalPaths(null)}
          onComplete={() => {
            setMoveModalPaths(null);
            useFileStore.getState().clearSelection();
            onRefreshTree?.();
          }}
        />
      )}
    </div>
  );
}
