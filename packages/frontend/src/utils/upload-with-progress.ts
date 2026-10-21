import i18n from '../i18n';

export type UploadProgressPhase = 'uploading' | 'processing';

export interface UploadProgressSnapshot {
  phase: UploadProgressPhase;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  completedFiles: number;
  totalFiles: number;
  currentFileName: string;
}

export function calculateUploadPercent(loadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((loadedBytes / totalBytes) * 100)));
}

interface UploadBatchOptions {
  url: string;
  token?: string | null;
  files: File[];
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
  onProgress: (snapshot: UploadProgressSnapshot) => void;
}

export function uploadFileBatchWithProgress({
  url,
  token,
  files,
  completedBytes,
  totalBytes,
  completedFiles,
  totalFiles,
  onProgress,
}: UploadBatchOptions): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    const batchBytes = files.reduce((sum, file) => sum + file.size, 0);
    const currentFileName = files.length === 1 ? files[0].name : i18n.t('uploadNotice.additionalFiles', { ns: 'common', name: files[0].name, count: files.length - 1 });

    xhr.open('POST', url);
    xhr.responseType = 'json';
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.addEventListener('progress', (event) => {
      const batchLoaded = event.lengthComputable ? Math.min(event.loaded, batchBytes) : 0;
      const loadedBytes = Math.min(totalBytes, completedBytes + batchLoaded);
      onProgress({
        phase: 'uploading',
        loadedBytes,
        totalBytes,
        percent: calculateUploadPercent(loadedBytes, totalBytes),
        completedFiles,
        totalFiles,
        currentFileName,
      });
    });
    xhr.upload.addEventListener('load', () => {
      const loadedBytes = Math.min(totalBytes, completedBytes + batchBytes);
      onProgress({
        phase: 'processing',
        loadedBytes,
        totalBytes,
        percent: calculateUploadPercent(loadedBytes, totalBytes),
        completedFiles,
        totalFiles,
        currentFileName,
      });
    });
    xhr.addEventListener('load', () => {
      const data = xhr.response ?? (() => {
        try { return JSON.parse(xhr.responseText); } catch { return {}; }
      })();
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!Array.isArray(data?.attachments)) reject(new Error('Invalid upload response; please retry'));
        else resolve(data);
      }
      else reject(new Error(data?.error || (xhr.status === 413 ? i18n.t('uploadNotice.tooLarge', { ns: 'common' }) : i18n.t('uploadNotice.failedGeneric', { ns: 'common' }))));
    });
    xhr.addEventListener('error', () => reject(new Error(i18n.t('uploadNotice.networkFailed', { ns: 'common' }))));
    xhr.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')));
    xhr.send(formData);
  });
}
