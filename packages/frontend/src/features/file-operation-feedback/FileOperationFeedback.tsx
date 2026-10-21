import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clearFileOperation, useFileOperationFeedback } from './feedback';

export function FileOperationFeedback({ scope }: { scope: string }) {
  const notice = useFileOperationFeedback(s => s.notices[scope]);
  const { t } = useTranslation('common');
  useEffect(() => {
    if (notice?.status !== 'saved') return;
    const timer = setTimeout(() => {
      if (useFileOperationFeedback.getState().notices[scope] === notice) clearFileOperation(scope);
    }, 3000);
    return () => clearTimeout(timer);
  }, [scope, notice]);
  if (!notice) return null;
  return <div role="status" aria-live="polite" className="m-2 flex items-start gap-2 rounded-lg border border-surface-700 px-3 py-2 text-sm text-gray-300">
    <span className="min-w-0 flex-1 break-words">{notice.message}</span>
    {notice.status !== 'pending' && <button type="button" onClick={() => clearFileOperation(scope)} className="shrink-0 underline">{t('fileOperation.dismiss')}</button>}
  </div>;
}
