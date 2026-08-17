// Owns: browser URL rendering inside the Tower Viewer. Public API: UrlPreviewSurface.
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isSafePreviewUrl } from './url-preview';

interface UrlPreviewSurfaceProps {
  url: string;
  className?: string;
  onChangeUrl?: () => void;
}

/** Render an explicitly chosen HTTP(S) URL without proxying or injecting Tower credentials. */
export function UrlPreviewSurface({ url, className = '', onChangeUrl }: UrlPreviewSurfaceProps) {
  const { t } = useTranslation('layout');
  const [revision, setRevision] = useState(0);
  const safeUrl = useMemo(() => isSafePreviewUrl(url) ? url : null, [url]);

  if (!safeUrl) {
    return (
      <div className={`flex items-center justify-center bg-surface-950 p-6 ${className}`}>
        <div className="max-w-md rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-200">
          {t('urlPreviewInvalid')}
        </div>
      </div>
    );
  }

  const copyUrl = async () => {
    await navigator.clipboard.writeText(safeUrl);
  };

  return (
    <div className={`flex min-h-0 flex-col bg-surface-950 ${className}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-surface-800 bg-surface-900 px-2 py-2">
        <div className="min-w-0 flex-1 truncate rounded-md border border-surface-700 bg-surface-950 px-2.5 py-1.5 font-mono text-xs text-surface-300" title={safeUrl}>
          {safeUrl}
        </div>
        {onChangeUrl && (
          <button type="button" onClick={onChangeUrl} className="rounded-md border border-surface-700 px-2.5 py-1.5 text-xs font-medium text-surface-300 hover:bg-surface-800 hover:text-surface-100" title={t('changePreviewUrl')}>
            {t('change')}
          </button>
        )}
        <button type="button" onClick={() => setRevision((value) => value + 1)} className="rounded-md border border-surface-700 px-2.5 py-1.5 text-xs font-medium text-surface-300 hover:bg-surface-800 hover:text-surface-100" title={t('refreshUrlPreview')}>
          {t('refresh')}
        </button>
        <button type="button" onClick={() => { void copyUrl(); }} className="rounded-md border border-surface-700 px-2.5 py-1.5 text-xs font-medium text-surface-300 hover:bg-surface-800 hover:text-surface-100" title={t('copyUrl')}>
          {t('copy')}
        </button>
        <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="rounded-md bg-primary-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-primary-500">
          {t('openInNewBrowserTab')}
        </a>
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          key={`${safeUrl}:${revision}`}
          src={safeUrl}
          title={t('urlPreview')}
          className="absolute inset-0 h-full w-full border-0 bg-white"
          sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      <div className="shrink-0 border-t border-surface-800 bg-surface-900 px-3 py-1.5 text-[11px] text-surface-500">
        {t('urlPreviewFrameNotice')}
      </div>
    </div>
  );
}
