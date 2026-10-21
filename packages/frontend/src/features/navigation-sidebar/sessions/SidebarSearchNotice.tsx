import React from 'react';
import type { TFunction } from 'i18next';

/** Do not render server error details or inaccessible-resource metadata. */
export function SidebarSearchNotice({ notice, t, onRetry }: {
  notice: 'partial' | 'failed' | null;
  t: TFunction<'layout'>;
  onRetry: () => void;
}) {
  if (!notice) return null;
  return <div role="status" aria-live="polite" className="px-3 py-2 text-xs text-surface-400">
    <p>{t(notice === 'partial' ? 'sessionSearchPartial' : 'sessionSearchFailed')}</p>
    <button type="button" onClick={onRetry} className="mt-1 rounded px-2 py-1 text-primary-400 hover:bg-surface-800">
      {t('sessionSearchRetry')}
    </button>
  </div>;
}
