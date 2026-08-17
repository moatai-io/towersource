import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson, safeStr } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';
import { useTranslation } from 'react-i18next';

interface NekoSpec {
  /** Optional URL path override (default: /neko/) */
  path?: string;
  /** Display height in pixels (default: 560) */
  height?: number;
  /** Description text shown above the iframe */
  description?: string;
}

interface Props {
  raw: string;
  fallbackCode: string;
}

// Fetch the Neko admin password from Tower backend so the iframe can load
// `/neko/?pwd=<pw>` — the Neko SPA reads that query param and auto-submits
// the login form (see app.js → autoPassword). On failure we fall back to the
// bare `/neko/` URL and the user can paste the password manually.
// ⚠ Neko is a SINGLE SHARED DESKTOP — auto-login is for convenience only.
async function fetchNekoPwd(): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    const tk = localStorage.getItem('token');
    if (tk) headers['Authorization'] = `Bearer ${tk}`;
    const r = await fetch('/api/neko/pwd', { headers });
    if (!r.ok) return null;
    const data = await r.json();
    return typeof data?.pwd === 'string' ? data.pwd : null;
  } catch {
    return null;
  }
}

export default function NekoBlock({ raw, fallbackCode }: Props) {
  const { t } = useTranslation('chat');
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pwd, setPwd] = useState<string | null>(null);
  const [pwdReady, setPwdReady] = useState(false);

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    return { ok: true as const, spec: r.data as NekoSpec };
  }, [raw]);

  // Fetch auto-login password once per mount. If it fails we still render
  // the iframe so the user can fall back to manual password entry.
  useEffect(() => {
    let cancelled = false;
    fetchNekoPwd().then((p) => {
      if (cancelled) return;
      setPwd(p);
      setPwdReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  const basePath = spec.path || '/neko/';
  // Only append pwd once the fetch attempt has completed — rendering the
  // iframe earlier would flash the Neko login screen and then re-mount when
  // the pwd arrives. Neko's SPA strips `?pwd=` from the URL immediately
  // after login via its own `removeUrlParam("pwd")` call.
  const nekoUrl = pwdReady && pwd
    ? `${basePath}${basePath.includes('?') ? '&' : '?'}pwd=${encodeURIComponent(pwd)}`
    : basePath;
  const height = expanded ? 720 : (spec.height || 560);

  return (
    <div className={`my-3 rounded-lg border overflow-hidden ${
      isDark ? 'border-purple-800/50 bg-purple-900/10' : 'border-purple-200 bg-purple-50'
    }`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-3 py-2 border-b ${
        isDark ? 'border-purple-800/30 bg-purple-900/20' : 'border-purple-200 bg-purple-50'
      }`}>
        <div className="flex items-center gap-2">
          <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-sm bg-purple-500/20 text-purple-400">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <span className={`text-sm font-medium ${isDark ? 'text-purple-300' : 'text-purple-700'}`}>
            {t('remoteBrowser')}
          </span>
          {spec.description && (
            <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              — {safeStr(spec.description)}
            </span>
          )}
          {!loaded && (
            <span className="flex items-center gap-1 text-[12px] text-gray-500">
              <span className="animate-pulse">{t('loading')}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded(!expanded)}
            className={`p-1 rounded transition-colors ${
              isDark ? 'hover:bg-surface-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
            }`}
            title={expanded ? t('shrink') : t('expand')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {expanded ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9L4 4m0 0v4m0-4h4m6 6l5 5m0 0v-4m0 4h-4" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
              )}
            </svg>
          </button>
          <button
            onClick={() => window.open(nekoUrl, '_blank')}
            className={`p-1 rounded transition-colors ${
              isDark ? 'hover:bg-surface-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
            }`}
            title={t('openInNewTab')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </button>
        </div>
      </div>

      {/* iframe — render only after the pwd fetch has resolved so Neko
          doesn't show the login screen on first paint and then swap. */}
      {pwdReady ? (
        <iframe
          src={nekoUrl}
          style={{ width: '100%', height: `${height}px`, border: 'none' }}
          allow="clipboard-read; clipboard-write"
          onLoad={() => setLoaded(true)}
        />
      ) : (
        <div
          style={{ width: '100%', height: `${height}px` }}
          className={`flex items-center justify-center text-sm ${
            isDark ? 'bg-surface-900 text-gray-500' : 'bg-gray-50 text-gray-400'
          }`}
        >
          <span className="animate-pulse">{t('connectingRemoteBrowser')}</span>
        </div>
      )}
    </div>
  );
}
