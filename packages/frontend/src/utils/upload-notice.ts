import i18n from '../i18n';
import { toastSuccess } from './toast';
import { clearFileOperation, reportUploadFailure } from '../features/file-operation-feedback/feedback';

export interface UploadNoticeResult {
  ok: number;
  fail: number;
  results?: Array<{ error?: string }>;
}

/** Failure belongs to the originating surface; success keeps its existing toast. */
export function notifyUploadResult({ ok, fail, results }: UploadNoticeResult, targetLabel?: string, scope = 'upload:sidebar'): void {
  if (fail > 0) {
    reportUploadFailure(scope, fail, ok, results);
    return;
  }
  clearFileOperation(scope);
  const target = targetLabel ? ` · ${targetLabel}` : '';
  if (ok > 0) toastSuccess(i18n.t('uploadNotice.success', { ns: 'common', ok, target }));
}
