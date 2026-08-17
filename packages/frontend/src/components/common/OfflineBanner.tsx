import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

export function OfflineBanner({ onReload }: { onReload?: () => void }) {
  const { t } = useTranslation('common');
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => setIsOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div role="alert" className="tone-warning tone-bg text-white text-center text-sm font-medium py-1.5 px-4 shrink-0 flex items-center justify-center gap-3">
      <span className="flex items-center gap-1.5">
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        {t('offline')}
      </span>
      <button
        onClick={() => (onReload ? onReload() : window.location.reload())}
        className="px-2 py-0.5 bg-white/20 hover:bg-white/30 rounded text-[12px] font-semibold transition-colors cursor-pointer"
      >
        {t('retry')}
      </button>
    </div>
  );
}
