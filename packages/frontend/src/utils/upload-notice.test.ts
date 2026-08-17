import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyUploadResult } from './upload-notice';
import { toastError, toastSuccess } from './toast';

vi.mock('./toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

describe('notifyUploadResult', () => {
  beforeEach(() => vi.clearAllMocks());
  it('emits one success notice for an all-success batch', () => {
    notifyUploadResult({ ok: 3, fail: 0 }, '문서/');
    expect(toastSuccess).toHaveBeenCalledOnce();
    expect(toastSuccess).toHaveBeenCalledWith('파일 3개를 올렸어요 · 문서/');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('emits one combined error notice for a partial failure', () => {
    notifyUploadResult({ ok: 2, fail: 1 });
    expect(toastError).toHaveBeenCalledOnce();
    expect(toastError).toHaveBeenCalledWith('파일 업로드 결과: 성공 2개, 실패 1개');
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
