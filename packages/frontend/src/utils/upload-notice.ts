import i18n from '../i18n';
import { toastError, toastSuccess } from './toast';

export interface UploadNoticeResult {
  ok: number;
  fail: number;
}

/**
 * Emit one terminal notice for an upload batch.
 * Progress belongs at the drop target/file surface; callers must not announce
 * a separate "uploading" toast before invoking this helper.
 */
export function notifyUploadResult({ ok, fail }: UploadNoticeResult, targetLabel?: string): void {
  const target = targetLabel ? ` · ${targetLabel}` : '';
  if (fail > 0) {
    const successPart = ok > 0 ? i18n.t('uploadNotice.successPart', { ns: 'common', ok }) : '';
    toastError(i18n.t('uploadNotice.failed', { ns: 'common', successPart, fail, target }));
    return;
  }
  if (ok > 0) {
    toastSuccess(i18n.t('uploadNotice.success', { ns: 'common', ok, target }));
  }
}
