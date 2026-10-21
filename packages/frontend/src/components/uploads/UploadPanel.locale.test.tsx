// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { UploadPanel } from './UploadPanel';
import { useUploadStore, type UploadStatus } from '../../stores/upload-store';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => useUploadStore.setState({ uploads: [] }));

describe('upload queue Korean copy and controls', () => {
  it('shows Korean fallback labels for every status without changing pause/resume/cancel behavior', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'ko', fallbackLng: false, resources: { ko: { common: { cancel: '취소' } } }, interpolation: { escapeValue: false } });
    const statuses: UploadStatus[] = ['queued', 'uploading', 'paused', 'completing', 'completed', 'failed', 'cancelled'];
    useUploadStore.setState({ uploads: statuses.map((status) => ({
      id: status, name: `${status}.txt`, targetDir: '/docs', status, totalBytes: 100, uploadedBytes: 50,
      totalFiles: 2, completedFiles: 1, currentFile: '보고서.txt', startedAt: 0, updatedAt: 0,
      cancelRequested: false, pauseRequested: false,
    })) });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<I18nextProvider i18n={i18n}><UploadPanel /></I18nextProvider>));
      for (const label of ['완료', '실패', '취소됨', '1/2개 파일', '완료된 항목 지우기']) {
        expect(container.textContent).toContain(label);
      }
      const allUploads = useUploadStore.getState().uploads;
      for (const [status, label] of [['queued', '대기 중'], ['uploading', '업로드 중'], ['paused', '일시 정지'], ['completing', '저장 마무리 중']]) {
        await act(async () => useUploadStore.setState({ uploads: allUploads.filter((item) => item.id === status) }));
        expect(container.textContent).toContain(label);
      }
      await act(async () => useUploadStore.setState({ uploads: allUploads.slice(0, 3) }));
      expect(container.textContent).toContain('현재 파일: 보고서.txt');
      const click = async (label: string) => {
        const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent === label);
        expect(button).toBeDefined();
        await act(async () => button!.click());
      };
      await click('일시 정지');
      expect(useUploadStore.getState().uploads.find((item) => item.id === 'uploading')?.pauseRequested).toBe(true);
      await click('다시 시작');
      expect(useUploadStore.getState().uploads.find((item) => item.id === 'paused')?.status).toBe('uploading');
      await click('취소');
      expect(useUploadStore.getState().uploads.find((item) => item.id === 'paused')?.cancelRequested).toBe(true);
      await act(async () => useUploadStore.setState({ uploads: allUploads }));
      await click('완료된 항목 지우기');
      expect(useUploadStore.getState().uploads).toHaveLength(5);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
