/**
 * RelatedSessionsPopover — Level 1 session backlinks UI.
 *
 * Shows other sessions that edited the same files as the source session.
 * Triggered from SessionContextMenu → "관련 세션" menu item.
 *
 * See: workspace/decisions/2026-04-21-session-backlinks-level1.md
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { RelatedSessionsResponse } from '@tower/shared';
import { useSessionStore } from '../../stores/session-store';

interface RelatedSessionsPopoverProps {
  sessionId: string;
  /** Anchor position (e.g. mouse coords from context-menu click). */
  x: number;
  y: number;
  onClose: () => void;
}

/** File path tail — e.g. `/home/.../search.ts` → `search.ts`. */
function fileTail(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function relativeTime(dateStr: string): string {
  let normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  if (!normalized.endsWith('Z') && !/[+-]\d{2}(:\d{2})?$/.test(normalized)) normalized += 'Z';
  const diff = Date.now() - new Date(normalized).getTime();
  if (isNaN(diff)) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `~${mins}m`;
  const hours = diff / 3600000;
  if (hours < 24) return `~${Math.round(hours * 10) / 10}h`;
  const days = hours / 24;
  if (days < 30) return `~${Math.round(days * 10) / 10}d`;
  return new Date(normalized).toLocaleDateString(i18n.resolvedLanguage || i18n.language, { month: 'short', day: 'numeric' });
}

export function RelatedSessionsPopover({ sessionId, x, y, onClose }: RelatedSessionsPopoverProps) {
  const { t } = useTranslation('layout');
  const ref = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState({ left: x, top: y });
  const [data, setData] = useState<RelatedSessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep data flowing even if the user moves the underlying menu around.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const token = localStorage.getItem('token');
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`/api/sessions/${sessionId}/related-by-files?limit=10`, {
          headers,
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as RelatedSessionsResponse;
        if (!cancelled) setData(json);
      } catch (e: any) {
        if (!cancelled) setError(e.message || t('relatedSessionsLoadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, t]);

  // Keep popover inside viewport (same pattern as SessionContextMenu)
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const pad = 8;
    const newTop =
      rect.bottom > window.innerHeight - pad
        ? Math.max(pad, window.innerHeight - rect.height - pad)
        : y;
    const newLeft =
      rect.right > window.innerWidth - pad
        ? Math.max(pad, window.innerWidth - rect.width - pad)
        : x;
    setAdjustedPos({ left: newLeft, top: newTop });
  }, [x, y, data, loading]);

  // Close on outside click / Escape
  useEffect(() => {
    const clickHandler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', clickHandler);
    document.addEventListener('touchstart', clickHandler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', clickHandler);
      document.removeEventListener('touchstart', clickHandler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  const handleSelect = (targetId: string) => {
    useSessionStore.getState().markSessionRead(targetId);
    window.dispatchEvent(new CustomEvent('kanban-select-session', {
      detail: { sessionId: targetId },
    }));
    onClose();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('relatedSessions')}
      className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl w-[320px] max-w-[90vw]"
      style={adjustedPos}
    >
      <div className="px-3 py-2 border-b border-surface-700/60 flex items-center gap-2">
        <svg
          className="w-3.5 h-3.5 text-primary-400 shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
        <span className="text-[14px] font-medium text-gray-200">{t('relatedSessions')}</span>
        {data && !loading && (
          <span
            className="ml-auto text-[12px] text-surface-600 tabular-nums"
            title={`${data.filesInSession} files · ${data.candidatesConsidered} candidates · ${data.queryMs}ms`}
          >
            {data.results.length}/{data.candidatesConsidered}
          </span>
        )}
      </div>

      <div className="max-h-[320px] overflow-y-auto">
        {loading && (
          <div className="px-3 py-6 text-center text-[13px] text-surface-500">{t('loading')}…</div>
        )}

        {!loading && error && (
          <div className="px-3 py-4 text-[13px] text-red-400">
            {t('loadFailed')}: {error}
          </div>
        )}

        {!loading && !error && data && data.results.length === 0 && (
          <div className="px-3 py-6 text-center text-[13px] text-surface-500">
            {t('noRelatedSessions')}
          </div>
        )}

        {!loading && !error && data && data.results.length > 0 && (
          <ul className="py-1">
            {data.results.map((r) => {
              // Cross-user byline: only show when the candidate isn't mine.
              // Fall back username → "user#<id>" if both are null (orphan row).
              const ownerLabel = r.isMine
                ? null
                : r.displayName || r.username || (r.userId ? `user#${r.userId}` : null);
              return (
                <li key={r.sessionId}>
                  <button
                    onClick={() => handleSelect(r.sessionId)}
                    className="w-full text-left px-3 py-2 hover:bg-primary-600/20 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="flex-1 min-w-0 truncate text-[14px] text-gray-200 font-medium"
                        title={r.name}
                      >
                        {r.name}
                      </span>
                      <span className="shrink-0 text-[12px] text-surface-600 tabular-nums">
                        {relativeTime(r.updatedAt)}
                      </span>
                    </div>
                    {ownerLabel && (
                      <div
                        className="mt-0.5 text-[12px] text-primary-300/80 truncate"
                        title={`Session owner: ${ownerLabel}`}
                      >
                        by {ownerLabel}
                      </div>
                    )}
                    {r.sharedFiles.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {r.sharedFiles.map((f) => (
                          <span
                            key={f.path}
                            className="text-[12px] text-surface-500 bg-surface-900/60 px-1.5 py-[1px] rounded"
                            title={f.path}
                          >
                            {fileTail(f.path)}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
