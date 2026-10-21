import React from 'react';
import { useProjectStore } from '../stores/project-store';
import { useRoomStore } from '../stores/room-store';
import { useSessionStore } from '../stores/session-store';
import { openPdfInBrowserTab } from './pdf-open';

/**
 * File-path link utilities shared by chat text, room messages, terminal output,
 * schedule cards, and media blocks.
 *
 * Owns: recognizing AI-emitted workspace paths and converting Runtime Box
 * container paths back to Tower host/project paths before opening/serving.
 */

export const IMAGE_FILE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
]);

export const PREVIEWABLE_FILE_EXTS = new Set([
  'pdf', ...IMAGE_FILE_EXTS,
  'html', 'htm', 'md', 'txt', 'json', 'yaml', 'yml',
  'ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'sql', 'css',
  'mp4', 'webm',
  'csv', 'tsv', 'ipynb', 'log', 'jsonl', 'xml', 'toml',
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
  'hwp', 'hwpx',
  'dxf', 'dwg',
  'mp3', 'wav', 'ogg', 'm4a', 'flac',
]);

export const FILE_PATH_CHAR = String.raw`[\w.@\-,+#%()가-힣ㄱ-ㅎㅏ-ㅣ ]`;
const FILE_PATH_SEGMENT = String.raw`${FILE_PATH_CHAR}+`;
const FILE_PATH_SEGMENT_NO_SPACE = String.raw`[\w.@\-,+#%()가-힣ㄱ-ㅎㅏ-ㅣ]+`;
const FILE_PATH_EXT = String.raw`\.[A-Za-z0-9]+`;
const ABS_FILE_PATH = String.raw`(?:\/${FILE_PATH_SEGMENT})+\/${FILE_PATH_SEGMENT}${FILE_PATH_EXT}`;
const ABS_DIR_PATH = String.raw`(?:\/${FILE_PATH_SEGMENT})+\/`;
const ABS_DIR_PATH_NO_TRAILING = String.raw`(?:\/${FILE_PATH_SEGMENT_NO_SPACE})+\/${FILE_PATH_SEGMENT_NO_SPACE}`;
const HOME_FILE_PATH = String.raw`~\/(?:${FILE_PATH_SEGMENT}\/)*${FILE_PATH_SEGMENT}${FILE_PATH_EXT}`;
const HOME_DIR_PATH = String.raw`~\/(?:${FILE_PATH_SEGMENT}\/)+`;
const HOME_DIR_PATH_NO_TRAILING = String.raw`~\/(?:${FILE_PATH_SEGMENT_NO_SPACE}\/)+${FILE_PATH_SEGMENT_NO_SPACE}`;
const REL_FILE_PATH = String.raw`\.\/(?:${FILE_PATH_SEGMENT}\/)*${FILE_PATH_SEGMENT}${FILE_PATH_EXT}`;
const REL_DIR_PATH = String.raw`\.\/(?:${FILE_PATH_SEGMENT}\/)+`;
const REL_DIR_PATH_NO_TRAILING = String.raw`\.\/(?:${FILE_PATH_SEGMENT_NO_SPACE}\/)+${FILE_PATH_SEGMENT_NO_SPACE}`;

export const FILE_PATH_REGEX = new RegExp(
  String.raw`(?:^|[\s"'\`(\[])((${ABS_FILE_PATH})|(${ABS_DIR_PATH})|(${HOME_FILE_PATH})|(${HOME_DIR_PATH})|(${REL_FILE_PATH})|(${REL_DIR_PATH})|(${ABS_DIR_PATH_NO_TRAILING})|(${HOME_DIR_PATH_NO_TRAILING})|(${REL_DIR_PATH_NO_TRAILING}))(?=(?::\d+)?(?::\d+)?(?:[\s"'\`),\]]|$))`,
  'g',
);

export function getFileExt(filePathOrUrl: string): string {
  const clean = filePathOrUrl.split(/[?#]/, 1)[0];
  return clean.split('.').pop()?.toLowerCase() || '';
}

export function hasPreviewableFileExt(filePath: string): boolean {
  const ext = getFileExt(filePath);
  return ext ? PREVIEWABLE_FILE_EXTS.has(ext) : false;
}

export function isPreviewableImageFilePath(filePathOrUrl: string): boolean {
  const ext = getFileExt(filePathOrUrl);
  return ext ? IMAGE_FILE_EXTS.has(ext) : false;
}

export function isTowerLocalPath(filePath: string): boolean {
  return filePath.startsWith('/home/') || filePath.startsWith('~/workspace/') || filePath.startsWith('~/tower/') || filePath.startsWith('/workspace/') || filePath.startsWith('./');
}

export function isDirectoryLikeTowerPath(filePath: string): boolean {
  const cleanPath = filePath.split(/[?#]/, 1)[0].trim();
  if (cleanPath.endsWith('/')) return true;
  if (!cleanPath.includes('/')) return false;
  const baseName = cleanPath.split('/').pop() || '';
  if (!baseName || baseName.includes('.')) return false;
  return isTowerLocalPath(cleanPath);
}

export function isLinkableTowerPath(filePath: string): boolean {
  return hasPreviewableFileExt(filePath) || isDirectoryLikeTowerPath(filePath);
}

function activeProjectRoot(): string | null {
  const sessionState = useSessionStore.getState();
  const activeSession = sessionState.sessions.find((s) => s.id === sessionState.activeSessionId);
  let projectId = activeSession?.projectId || null;

  if (!projectId) {
    const roomState = useRoomStore.getState();
    const activeRoom = roomState.rooms.find((room) => room.id === roomState.activeRoomId);
    projectId = activeRoom?.projectId || null;
  }

  if (!projectId) return null;
  return useProjectStore.getState().projects.find((p) => p.id === projectId)?.rootPath || null;
}

/**
 * Convert Runtime Box paths (`/workspace/...`) to the active Tower project root.
 * Other paths are only trimmed. If we cannot infer a project, return unchanged.
 */
export function normalizeTowerFilePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const projects = useProjectStore.getState().projects;

  // Portable AI-emitted paths should match the concrete paths used by the
  // sidebar tree (`/home/.../workspace/projects/...`). Without this, reveal can
  // fail because the DOM data-sidebar-file-path uses absolute host paths while
  // chat text often contains `~/workspace/...`.
  if (trimmed.startsWith('~/workspace/projects/')) {
    const rest = trimmed.slice('~/workspace/projects/'.length);
    const [slug, ...tail] = rest.split('/');
    const project = projects.find((p) => p.rootPath?.endsWith(`/projects/${slug}`));
    if (project?.rootPath) return [project.rootPath.replace(/\/$/, ''), ...tail].join('/');
  }

  if (trimmed.startsWith('~/workspace/')) {
    const projectRoot = projects.find((p) => p.rootPath?.includes('/workspace/projects/'))?.rootPath;
    const workspaceRoot = projectRoot?.split('/projects/')[0];
    if (workspaceRoot) return `${workspaceRoot}${trimmed.slice('~/workspace'.length)}`;
  }

  if (!trimmed.startsWith('/workspace/')) return trimmed;
  const rootPath = activeProjectRoot();
  if (!rootPath) return trimmed;
  return `${rootPath.replace(/\/$/, '')}${trimmed.slice('/workspace'.length)}`;
}

export function openTowerFile(filePath: string) {
  const normalizedPath = normalizeTowerFilePath(filePath);
  if (typeof window !== 'undefined') {
    const inMainTowerApp = window.location.pathname !== '/file-viewer' && !window.location.pathname.startsWith('/shared/');
    if (inMainTowerApp && (isLinkableTowerPath(normalizedPath) || isTowerLocalPath(normalizedPath))) {
      // Prefer the mounted app shell's file-tab flow over browser navigation.
      // The old fallback opened `/file-viewer?path=...` in a new window; in PWA
      // and some mobile/browser contexts that can replace/reload the current
      // Tower page, which is especially painful for PDF clicks.
      window.dispatchEvent(new CustomEvent('tower-open-path', { detail: { path: normalizedPath } }));
      return;
    }
  }
  window.open(fileViewerUrl(normalizedPath), '_blank', 'noopener,noreferrer');
}

/** Ask the mounted Tower shell to reveal a file in its owning AI teammate workspace. */
export function revealTowerFileLocation(filePath: string) {
  const normalizedPath = normalizeTowerFilePath(filePath);
  if (typeof window !== 'undefined' && window.location.pathname !== '/shared/') {
    window.dispatchEvent(new CustomEvent('tower-reveal-tab-target', { detail: { kind: 'file', path: normalizedPath } }));
  }
}

/** @deprecated Use revealTowerFileLocation. */
export const revealTowerFileInSidebar = revealTowerFileLocation;

export async function createTowerFileShortLink(filePath: string): Promise<string> {
  const normalizedPath = normalizeTowerFilePath(filePath);
  const token = localStorage.getItem('token') || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch('/api/file-links', {
    method: 'POST',
    headers,
    body: JSON.stringify({ filePath: normalizedPath }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to create file link');
  }
  const data = await res.json();
  return `${window.location.origin}${data.url}`;
}

export function fileViewerUrl(filePath: string): string {
  return `/file-viewer?path=${encodeURIComponent(normalizeTowerFilePath(filePath))}`;
}

/** Open a Tower-local file in a browser tab, bypassing the in-app file tab when useful. */
export function openTowerFileInBrowserTab(filePath: string) {
  const normalizedPath = normalizeTowerFilePath(filePath);
  const ext = getFileExt(normalizedPath);
  if (ext === 'pdf') {
    openPdfInBrowserTab(normalizedPath);
    return;
  }
  if (IMAGE_FILE_EXTS.has(ext) || ['html', 'htm', 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) {
    window.open(fileServeUrl(normalizedPath), '_blank', 'noopener,noreferrer');
    return;
  }
  window.open(fileViewerUrl(normalizedPath), '_blank', 'noopener,noreferrer');
}

export function fileServeUrl(filePathOrUrl: string): string {
  const src = filePathOrUrl.trim();
  if (src.startsWith('/api/files/serve')) {
    if (src.includes('token=')) return src;
    const token = localStorage.getItem('token') || '';
    const sep = src.includes('?') ? '&' : '?';
    return `${src}${sep}token=${encodeURIComponent(token)}`;
  }
  if (isTowerLocalPath(src)) {
    const token = localStorage.getItem('token') || '';
    return `/api/files/serve?path=${encodeURIComponent(normalizeTowerFilePath(src))}&token=${encodeURIComponent(token)}`;
  }
  return src;
}

export function fileThumbnailUrl(filePath: string): string {
  const token = localStorage.getItem('token') || '';
  return `/api/files/thumbnail?path=${encodeURIComponent(normalizeTowerFilePath(filePath))}&token=${encodeURIComponent(token)}`;
}

export function splitFilePathsInText(
  text: string,
  onFileClick: (path: string) => void,
  renderLink: (filePath: string, key: string | number) => React.ReactNode,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const regex = new RegExp(FILE_PATH_REGEX.source, 'g');

  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0];
    const filePath = match[1];
    const pathStart = (match.index ?? 0) + fullMatch.indexOf(filePath);

    if (!isLinkableTowerPath(filePath)) continue;
    if (pathStart > lastIndex) parts.push(text.slice(lastIndex, pathStart));
    parts.push(renderLink(filePath, `${pathStart}-${filePath}`));
    lastIndex = pathStart + filePath.length;
  }

  if (lastIndex === 0) return [];
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

/** Download local files with authenticated fetch; never navigate to a host filesystem URL. */
export async function downloadTowerFile(filePath: string): Promise<void> {
  const normalized = normalizeTowerFilePath(filePath);
  const token = localStorage.getItem('token') || '';
  const response = await fetch(`/api/files/serve?path=${encodeURIComponent(normalized)}&download=1`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`파일 다운로드에 실패했습니다 (HTTP ${response.status}).`);
  if ((response.headers.get('content-type') || '').includes('text/html') && getFileExt(normalized) !== 'html') {
    throw new Error('파일 대신 웹 화면이 반환되었습니다. 다운로드 경로를 확인해야 합니다.');
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = normalized.split('/').pop() || 'download';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
