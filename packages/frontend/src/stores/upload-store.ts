import { create } from 'zustand';

export type UploadStatus = 'queued' | 'uploading' | 'paused' | 'completing' | 'completed' | 'failed' | 'cancelled';

export interface UploadItem {
  id: string;
  name: string;
  targetDir: string;
  status: UploadStatus;
  totalBytes: number;
  uploadedBytes: number;
  totalFiles: number;
  completedFiles: number;
  currentFile?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  pauseRequested: boolean;
}

interface UploadState {
  uploads: UploadItem[];
  upsertUpload: (upload: UploadItem) => void;
  updateUpload: (id: string, patch: Partial<UploadItem>) => void;
  requestPause: (id: string) => void;
  requestResume: (id: string) => void;
  requestCancel: (id: string) => void;
  removeUpload: (id: string) => void;
  clearCompleted: () => void;
}

export const useUploadStore = create<UploadState>((set) => ({
  uploads: [],
  upsertUpload: (upload) => set((s) => {
    const exists = s.uploads.some((u) => u.id === upload.id);
    return exists
      ? { uploads: s.uploads.map((u) => (u.id === upload.id ? upload : u)) }
      : { uploads: [...s.uploads, upload] };
  }),
  updateUpload: (id, patch) => set((s) => ({
    uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...patch, updatedAt: Date.now() } : u)),
  })),
  requestPause: (id) => set((s) => ({
    uploads: s.uploads.map((u) => (u.id === id ? { ...u, pauseRequested: true, status: 'paused', updatedAt: Date.now() } : u)),
  })),
  requestResume: (id) => set((s) => ({
    uploads: s.uploads.map((u) => (u.id === id ? { ...u, pauseRequested: false, status: 'uploading', updatedAt: Date.now() } : u)),
  })),
  requestCancel: (id) => set((s) => ({
    uploads: s.uploads.map((u) => (u.id === id ? { ...u, cancelRequested: true, status: 'cancelled', updatedAt: Date.now() } : u)),
  })),
  removeUpload: (id) => set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) })),
  clearCompleted: () => set((s) => ({ uploads: s.uploads.filter((u) => !['completed', 'cancelled'].includes(u.status)) })),
}));

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}
