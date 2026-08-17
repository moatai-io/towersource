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
    const successPart = ok > 0 ? `성공 ${ok}개, ` : '';
    toastError(`파일 업로드 결과: ${successPart}실패 ${fail}개${target}`);
    return;
  }
  if (ok > 0) {
    toastSuccess(`파일 ${ok}개를 올렸어요${target}`);
  }
}
