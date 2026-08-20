/**
 * Folder drag-and-drop helper.
 *
 * Browsers expose `e.dataTransfer.files` as a flat FileList — folders come
 * through as empty placeholders. To preserve directory structure, we walk
 * `e.dataTransfer.items[i].webkitGetAsEntry()` recursively and emit each
 * file with its relative path.
 *
 * Falls back to `dataTransfer.files` when items aren't available
 * (older browsers, programmatic drops).
 */

import i18n from '../i18n';
import { useProjectStore } from '../stores/project-store';
import { useUploadStore } from '../stores/upload-store';
import { calculateUploadPercent, type UploadProgressSnapshot } from './upload-with-progress';

export type DroppedFile = { file: File; relativePath: string };

/** Read every File out of a drop event, preserving relative paths for folders. */
export async function readDroppedItems(
  dataTransfer: DataTransfer,
): Promise<DroppedFile[]> {
  const items = dataTransfer.items;
  const fallbackFiles = dataTransfer.files;

  // Try webkitGetAsEntry first — only path that exposes directory structure
  const entries: FileSystemEntry[] = [];
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Only "file" kind has webkitGetAsEntry
      if (item.kind !== 'file') continue;
      // webkitGetAsEntry exists on Chromium/WebKit/Firefox
      const getEntry = (item as any).webkitGetAsEntry?.bind(item);
      if (typeof getEntry !== 'function') continue;
      const entry: FileSystemEntry | null = getEntry();
      if (entry) entries.push(entry);
    }
  }

  if (entries.length > 0) {
    const out: DroppedFile[] = [];
    for (const entry of entries) {
      await walkEntry(entry, '', out);
    }
    return out;
  }

  // Fallback: flat file list, no directory structure
  return Array.from(fallbackFiles).map((f) => ({ file: f, relativePath: f.name }));
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedFile[],
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file: File = await new Promise((resolve, reject) =>
      fileEntry.file(resolve, reject),
    );
    out.push({
      file,
      relativePath: prefix ? `${prefix}/${entry.name}` : entry.name,
    });
    return;
  }

  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    // readEntries returns at most ~100 per call — loop until empty batch.
    const all: FileSystemEntry[] = [];
    while (true) {
      const batch: FileSystemEntry[] = await new Promise((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      all.push(...batch);
    }
    for (const child of all) {
      await walkEntry(child, subPrefix, out);
    }
  }
}

/** Result shape returned by /api/files/upload. */
export type UploadResult = { name: string; path: string; error?: string };

/**
 * POST a list of dropped files to the upload endpoint, sending parallel
 * `files` and `relativePaths` arrays so the backend can re-create the
 * directory tree.
 */
export async function uploadDroppedFiles(
  targetDir: string,
  items: DroppedFile[],
  onProgress?: (snapshot: UploadProgressSnapshot) => void,
): Promise<{ results: UploadResult[]; ok: number; fail: number }> {
  if (items.length === 0) {
    return { results: [], ok: 0, fail: 0 };
  }

  const totalBytes = items.reduce((sum, it) => sum + it.file.size, 0);
  const useResumable = shouldUseResumableUpload(items, totalBytes);
  const projectId = inferProjectIdForTargetDir(targetDir);
  if (useResumable && projectId) {
    return uploadDroppedFilesResumable(targetDir, projectId, items, totalBytes, onProgress);
  }

  return uploadDroppedFilesMultipart(targetDir, items, onProgress);
}

async function uploadDroppedFilesMultipart(
  targetDir: string,
  items: DroppedFile[],
  onProgress?: (snapshot: UploadProgressSnapshot) => void,
): Promise<{ results: UploadResult[]; ok: number; fail: number }> {
  // IMPORTANT: append text fields BEFORE file fields. Multer's
  // `upload.array('files', N)` parses the multipart stream sequentially —
  // if a non-file field appears between file parts (or before the first
  // file with an unexpected name), some multer/busboy combos throw
  // "Unexpected field". Sending all text first avoids that, and lets us
  // pass relativePaths as one JSON blob instead of N parallel fields.
  const formData = new FormData();
  formData.append('targetDir', targetDir);
  formData.append(
    'relativePaths',
    JSON.stringify(items.map((it) => it.relativePath)),
  );
  for (const { file } of items) {
    formData.append('files', file);
  }

  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const currentFileName = items.length === 1 ? items[0].relativePath : i18n.t('uploadNotice.additionalFiles', { ns: 'common', name: items[0].relativePath, count: items.length - 1 });
  const res = await postFormDataWithProgress('/api/files/upload', formData, {
    totalBytes,
    totalFiles: items.length,
    currentFileName,
    onProgress,
  });
  const results: UploadResult[] = res.results || [];
  const ok = results.filter((r) => !r.error).length;
  const fail = results.filter((r) => r.error).length;
  return { results, ok, fail };
}

function shouldUseResumableUpload(items: DroppedFile[], totalBytes: number): boolean {
  const largePayload = totalBytes > 100 * 1024 * 1024;
  const largeFile = items.some((it) => it.file.size > 100 * 1024 * 1024);
  const manyFiles = items.length > 100;
  return largePayload || largeFile || manyFiles;
}

function inferProjectIdForTargetDir(targetDir: string): string | null {
  const projects = useProjectStore.getState().projects
    .filter((p) => p.rootPath)
    .sort((a, b) => (b.rootPath?.length || 0) - (a.rootPath?.length || 0));
  const normalizedTarget = targetDir.replace(/\\/g, '/');
  for (const project of projects) {
    const root = project.rootPath!.replace(/\\/g, '/');
    if (normalizedTarget === root || normalizedTarget.startsWith(`${root}/`)) return project.id;
  }
  return null;
}

async function uploadDroppedFilesResumable(
  targetDir: string,
  projectId: string,
  items: DroppedFile[],
  totalBytes: number,
  onProgress?: (snapshot: UploadProgressSnapshot) => void,
): Promise<{ results: UploadResult[]; ok: number; fail: number }> {
  const uploadId = crypto.randomUUID();
  const uploadName = items[0]?.relativePath.split('/')[0] || 'Upload';
  const uploadStore = useUploadStore.getState();
  uploadStore.upsertUpload({
    id: uploadId,
    name: uploadName,
    targetDir,
    status: 'queued',
    totalBytes,
    uploadedBytes: 0,
    totalFiles: items.length,
    completedFiles: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    cancelRequested: false,
    pauseRequested: false,
  });
  try {
  uploadStore.updateUpload(uploadId, { status: 'uploading' });
  const session = await fetchJson('/api/files/resumable-upload/sessions', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      targetDir,
      files: items.map((it) => ({
        relativePath: it.relativePath,
        size: it.file.size,
        lastModified: it.file.lastModified,
      })),
    }),
  });

  const chunkSize = Number(session.chunkSize || 8 * 1024 * 1024);
  const filesByPath = new Map(items.map((it) => [it.relativePath, it.file]));
  let uploadedBytes = 0;
  let completedFiles = 0;

  for (const serverFile of session.files || []) {
    const file = filesByPath.get(serverFile.relativePath);
    if (!file) continue;
    const uploaded = new Set<number>(serverFile.uploadedChunks || []);
    const chunkCount = Number(serverFile.chunkCount || Math.ceil(file.size / chunkSize));
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      await waitWhilePaused(uploadId);
      if (useUploadStore.getState().uploads.find((u) => u.id === uploadId)?.cancelRequested) {
        await cancelResumableSession(session.uploadSessionId);
        throw new Error('Upload cancelled');
      }
      if (uploaded.has(chunkIndex)) {
        uploadedBytes += Math.min(chunkSize, Math.max(0, file.size - chunkIndex * chunkSize));
        continue;
      }
      const start = chunkIndex * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const chunk = file.slice(start, end);
      uploadStore.updateUpload(uploadId, { currentFile: serverFile.relativePath, uploadedBytes, completedFiles });
      onProgress?.({ phase: 'uploading', loadedBytes: uploadedBytes, totalBytes, percent: calculateUploadPercent(uploadedBytes, totalBytes), completedFiles, totalFiles: items.length, currentFileName: serverFile.relativePath });
      await fetchJsonWithRetry(`/api/files/resumable-upload/sessions/${encodeURIComponent(session.uploadSessionId)}/files/${encodeURIComponent(serverFile.fileId)}/chunks/${chunkIndex}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
        body: chunk,
      }, uploadId);
      uploadedBytes += chunk.size;
      uploadStore.updateUpload(uploadId, { uploadedBytes, error: undefined });
      onProgress?.({ phase: 'uploading', loadedBytes: uploadedBytes, totalBytes, percent: calculateUploadPercent(uploadedBytes, totalBytes), completedFiles, totalFiles: items.length, currentFileName: serverFile.relativePath });
    }
    completedFiles++;
    uploadStore.updateUpload(uploadId, { completedFiles });
  }

  uploadStore.updateUpload(uploadId, { status: 'completing', currentFile: undefined, uploadedBytes: totalBytes, completedFiles: items.length });
  onProgress?.({ phase: 'processing', loadedBytes: totalBytes, totalBytes, percent: 100, completedFiles: items.length, totalFiles: items.length, currentFileName: uploadName });
  const completed = await fetchJson(`/api/files/resumable-upload/sessions/${encodeURIComponent(session.uploadSessionId)}/complete`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ overwrite: false }),
  });

  const results: UploadResult[] = (completed.results || []).map((r: any) => ({
    name: r.relativePath,
    path: r.path,
  }));
  uploadStore.updateUpload(uploadId, { status: 'completed', uploadedBytes: totalBytes, completedFiles: items.length });
  return { results, ok: results.length, fail: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    uploadStore.updateUpload(uploadId, { status: message === 'Upload cancelled' ? 'cancelled' : 'failed', error: message });
    throw err;
  }
}

async function waitWhilePaused(uploadId: string): Promise<void> {
  while (true) {
    const upload = useUploadStore.getState().uploads.find((u) => u.id === uploadId);
    if (upload?.cancelRequested) throw new Error('Upload cancelled');
    if (!upload?.pauseRequested) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function cancelResumableSession(sessionId: string): Promise<void> {
  await fetch(`/api/files/resumable-upload/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  }).catch(() => {});
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchJsonWithRetry(url: string, init: RequestInit, uploadId: string): Promise<any> {
  const delays = [500, 1000, 2500];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fetchJson(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length) break;
      useUploadStore.getState().updateUpload(uploadId, { error: `Retrying chunk after network error (${attempt + 1}/${delays.length})` });
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      if (useUploadStore.getState().uploads.find((u) => u.id === uploadId)?.cancelRequested) throw new Error('Upload cancelled');
      await waitWhilePaused(uploadId);
    }
  }
  throw lastErr;
}

function postFormDataWithProgress(
  url: string,
  formData: FormData,
  options: { totalBytes: number; totalFiles: number; currentFileName: string; onProgress?: (snapshot: UploadProgressSnapshot) => void },
): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    const token = localStorage.getItem('token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.addEventListener('progress', (event) => {
      const loadedBytes = event.lengthComputable ? Math.min(options.totalBytes, event.loaded) : 0;
      options.onProgress?.({
        phase: 'uploading', loadedBytes, totalBytes: options.totalBytes,
        percent: calculateUploadPercent(loadedBytes, options.totalBytes), completedFiles: 0,
        totalFiles: options.totalFiles, currentFileName: options.currentFileName,
      });
    });
    xhr.upload.addEventListener('load', () => options.onProgress?.({
      phase: 'processing', loadedBytes: options.totalBytes, totalBytes: options.totalBytes,
      percent: 100, completedFiles: 0, totalFiles: options.totalFiles, currentFileName: options.currentFileName,
    }));
    xhr.addEventListener('load', () => {
      const data = xhr.response ?? (() => { try { return JSON.parse(xhr.responseText); } catch { return {}; } })();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || (xhr.status === 413 ? i18n.t('uploadNotice.tooLarge', { ns: 'common' }) : `Upload failed (${xhr.status})`)));
    });
    xhr.addEventListener('error', () => reject(new Error(i18n.t('uploadNotice.networkFailed', { ns: 'common' }))));
    xhr.send(formData);
  });
}

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error(`Upload failed (${res.status}): server returned non-JSON response`);
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Upload failed (${res.status})`);
  }
  return data;
}

/** Count distinct top-level folder names in a DroppedFile list (for friendly toasts). */
export function countTopLevelFolders(items: DroppedFile[]): number {
  const folders = new Set<string>();
  for (const { relativePath } of items) {
    const idx = relativePath.indexOf('/');
    if (idx > 0) folders.add(relativePath.slice(0, idx));
  }
  return folders.size;
}
