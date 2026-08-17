// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { calculateUploadPercent, uploadFileBatchWithProgress } from './upload-with-progress';

describe('upload-with-progress', () => {
  it('calculates a bounded byte-weighted percentage', () => {
    expect(calculateUploadPercent(50, 200)).toBe(25);
    expect(calculateUploadPercent(300, 200)).toBe(100);
    expect(calculateUploadPercent(-10, 200)).toBe(0);
  });

  it('reports upload bytes before the server processing phase', async () => {
    const snapshots: any[] = [];
    class FakeXHR {
      status = 200;
      response: any = { attachments: [] };
      responseText = '';
      responseType = '';
      uploadListeners: Record<string, Function[]> = {};
      listeners: Record<string, Function[]> = {};
      upload = { addEventListener: (name: string, listener: Function) => (this.uploadListeners[name] ||= []).push(listener) };
      open = vi.fn();
      setRequestHeader = vi.fn();
      addEventListener = (name: string, listener: Function) => (this.listeners[name] ||= []).push(listener);
      send = () => {
        this.uploadListeners.progress?.forEach(fn => fn({ lengthComputable: true, loaded: 40, total: 100 }));
        this.uploadListeners.load?.forEach(fn => fn({}));
        this.listeners.load?.forEach(fn => fn());
      };
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const file = new File([new Uint8Array(100)], 'large.exe');

    await uploadFileBatchWithProgress({
      url: '/upload', files: [file], completedBytes: 20, totalBytes: 200,
      completedFiles: 1, totalFiles: 2, onProgress: snapshot => snapshots.push(snapshot),
    });

    expect(snapshots).toEqual([
      expect.objectContaining({ phase: 'uploading', loadedBytes: 60, percent: 30, currentFileName: 'large.exe' }),
      expect.objectContaining({ phase: 'processing', loadedBytes: 120, percent: 60 }),
    ]);
  });
});
