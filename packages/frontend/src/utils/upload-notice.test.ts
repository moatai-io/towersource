import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./toast', () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
import { toastError, toastSuccess } from './toast';
import i18n from '../i18n';
import { notifyUploadResult } from './upload-notice';
import { useFileOperationFeedback } from '../features/file-operation-feedback/feedback';
beforeEach(async () => {
  vi.clearAllMocks(); useFileOperationFeedback.setState({ notices: {} }); await i18n.changeLanguage('en');
});
describe('upload notice policy', () => {
  it('preserves success notifications and clears old scoped errors', () => {
    notifyUploadResult({ ok: 0, fail: 1 }, undefined, 'upload:a');
    notifyUploadResult({ ok: 3, fail: 0 }, 'target', 'upload:a');
    expect(toastSuccess).toHaveBeenCalledOnce();
    expect(useFileOperationFeedback.getState().notices['upload:a']).toBeUndefined();
  });
  it.each(['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'unknown-private-detail'])('renders safe inline failure for %s', error => {
    notifyUploadResult({ ok: 2, fail: 1, results: [{ error }] }, 'target', 'upload:a');
    const notice = useFileOperationFeedback.getState().notices['upload:a'];
    expect(notice.status).toBe('failed');
    expect(notice.message).not.toContain(error);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
  it('is silent for an empty result', () => {
    notifyUploadResult({ ok: 0, fail: 0 });
    expect(toastSuccess).not.toHaveBeenCalled(); expect(toastError).not.toHaveBeenCalled();
  });
});
