import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { notifyUploadResult } from './upload-notice';
import { toastError, toastSuccess } from './toast';

vi.mock('./toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

describe('notifyUploadResult', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
  });
  it('emits one success notice for an all-success batch', () => {
    notifyUploadResult({ ok: 3, fail: 0 }, 'Documents/');
    expect(toastSuccess).toHaveBeenCalledOnce();
    expect(toastSuccess).toHaveBeenCalledWith('Uploaded 3 file(s) · Documents/');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('emits one combined error notice for a partial failure', () => {
    notifyUploadResult({ ok: 2, fail: 1 });
    expect(toastError).toHaveBeenCalledOnce();
    expect(toastError).toHaveBeenCalledWith('File upload result: 2 succeeded, 1 failed');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('follows the active Korean language', async () => {
    await i18n.changeLanguage('ko');
    notifyUploadResult({ ok: 1, fail: 0 });
    expect(toastSuccess).toHaveBeenCalledWith('파일 1개를 올렸어요');
  });
});
