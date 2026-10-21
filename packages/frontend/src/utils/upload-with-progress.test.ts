// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { towerHttpUrl } from '../features/client-connection/connection';
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

it.each([
  [200, null, 'Invalid upload response'],
  [403, { error: 'Access denied' }, 'Access denied'],
])('rejects invalid or failed responses (%s)', async (status, response, message) => {
  class FakeXHR {
    status = status; response = response; responseType = ''; responseText = '';
    upload = { addEventListener: vi.fn() }; open = vi.fn(); setRequestHeader = vi.fn();
    listeners: Record<string, Function> = {};
    addEventListener(name: string, fn: Function) { this.listeners[name] = fn; }
    send() { this.listeners.load(); }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  try {
    await expect(uploadFileBatchWithProgress({ url: '/upload', files: [new File(['png'], 'capture.png')], completedBytes: 0, totalBytes: 3, completedFiles: 0, totalFiles: 1, onProgress: vi.fn() })).rejects.toThrow(message);
  } finally { vi.unstubAllGlobals(); }
});

it('sends the resolved Tower URL and auth without changing the XHR transport', async () => {
  const open = vi.fn();
  const header = vi.fn();
  class FakeXHR {
    status = 200; response = { attachments: [] }; upload = { addEventListener: vi.fn() };
    open = open; setRequestHeader = header; responseType = '';
    listeners: Record<string, Function> = {};
    addEventListener(name: string, fn: Function) { this.listeners[name] = fn; }
    send() { this.listeners.load(); }
  }
  vi.stubEnv('VITE_API_URL', 'https://tower.example.com/');
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  try {
    await uploadFileBatchWithProgress({ url: towerHttpUrl('/api/files/upload?sessionId=session%20a'), token: 'synthetic', files: [new File(['a'], 'a.txt')], completedBytes: 0, totalBytes: 1, completedFiles: 0, totalFiles: 1, onProgress: vi.fn() });
    expect(open).toHaveBeenCalledWith('POST', 'https://tower.example.com/api/files/upload?sessionId=session%20a');
    expect(header).toHaveBeenCalledWith('Authorization', 'Bearer synthetic');
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
