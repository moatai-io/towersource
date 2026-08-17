import { useMemo, useState, useCallback } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson, safeStr } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';
import { useTranslation } from 'react-i18next';

interface BrowserPopupSpec {
  url: string;
  label?: string;
  description?: string;
  /** OAuth callback path on Tower server, e.g. "/api/oauth/callback" */
  callbackPath?: string;
  /** Popup window dimensions */
  width?: number;
  height?: number;
}

interface Props {
  raw: string;
  fallbackCode: string;
}

export default function BrowserPopupBlock({ raw, fallbackCode }: Props) {
  const { t } = useTranslation('chat');
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';
  const [status, setStatus] = useState<'idle' | 'opened' | 'done' | 'error'>('idle');
  const [popupRef, setPopupRef] = useState<Window | null>(null);

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as BrowserPopupSpec;
    if (!spec.url) return { ok: false as const, error: 'Missing "url" field' };
    return { ok: true as const, spec };
  }, [raw]);

  const handleOpen = useCallback(() => {
    if (!parsed.ok) return;
    const { spec } = parsed;
    const w = spec.width || 600;
    const h = spec.height || 700;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);

    const popup = window.open(
      spec.url,
      '_blank',
      `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=yes,status=no`,
    );

    if (!popup) {
      setStatus('error');
      return;
    }

    setPopupRef(popup);
    setStatus('opened');

    // Poll to detect when popup is closed
    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        setStatus('done');
        setPopupRef(null);
      }
    }, 500);
  }, [parsed]);

  const handleFocus = useCallback(() => {
    popupRef?.focus();
  }, [popupRef]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  // Extract domain for display
  let domain = '';
  try { domain = new URL(spec.url).hostname; } catch { domain = spec.url; }

  return (
    <div className={`my-3 rounded-lg border p-3 ${
      isDark ? 'border-blue-800/50 bg-blue-900/10' : 'border-blue-200 bg-blue-50'
    }`}>
      <div className="flex items-start gap-2.5">
        {/* Globe icon */}
        <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-lg bg-blue-500/20 text-blue-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          {spec.description && (
            <div className={`text-base ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
              {safeStr(spec.description)}
            </div>
          )}
          <div className={`text-[13px] mt-0.5 font-mono truncate ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {domain}
          </div>

          <div className="flex items-center gap-2 mt-2.5">
            {status === 'idle' && (
              <button
                onClick={handleOpen}
                className="px-3 py-1.5 rounded text-sm font-medium transition-colors bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                {spec.label || t('openBrowser')}
              </button>
            )}

            {status === 'opened' && (
              <>
                <span className="flex items-center gap-1.5 text-sm text-blue-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                  </span>
                  {t('popupOpened')}
                </span>
                <button
                  onClick={handleFocus}
                  className={`px-2 py-1 rounded text-[13px] transition-colors ${
                    isDark
                      ? 'bg-surface-700 hover:bg-surface-600 text-gray-300'
                      : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                  }`}
                >
                  {t('focus')}
                </button>
              </>
            )}

            {status === 'done' && (
              <span className="tone-success tone-text flex items-center gap-1.5 text-sm font-medium">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                {t('done')}
              </span>
            )}

            {status === 'error' && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-red-400">
                  {t('popupBlocked')}
                </span>
                <button
                  onClick={handleOpen}
                  className={`px-2 py-1 rounded text-[13px] transition-colors ${
                    isDark
                      ? 'bg-surface-700 hover:bg-surface-600 text-gray-300'
                      : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                  }`}
                >
                  {t('retry')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
