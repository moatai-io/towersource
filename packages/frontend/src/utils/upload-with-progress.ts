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
    const currentFileName = files.length === 1 ? files[0].name : `${files[0].name} 외 ${files.length - 1}개`;

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
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || (xhr.status === 413 ? '파일이 업로드 허용 크기를 초과했습니다.' : '파일을 업로드하지 못했습니다.')));
    });
    xhr.addEventListener('error', () => reject(new Error('네트워크 연결로 파일을 업로드하지 못했습니다.')));
    xhr.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')));
    xhr.send(formData);
  });
}
