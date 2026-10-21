import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore, type SessionMeta } from '../../stores/session-store';

interface SummaryCardProps {
  session: SessionMeta;
}

export function SummaryCard({ session }: SummaryCardProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const updateSessionMeta = useSessionStore((s) => s.updateSessionMeta);

  const turnCount = session.turnCount ?? 0;
  const summaryAtTurn = session.summaryAtTurn ?? 0;
  const filesCount = session.filesEdited?.length ?? 0;
  const isStale = session.summary && turnCount - summaryAtTurn >= 5;

  const handleSummarize = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`/api/sessions/${session.id}/summarize`, {
        method: 'POST',
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        updateSessionMeta(session.id, {
          summary: data.summary,
          summaryAtTurn: data.summaryAtTurn,
        });
        setExpanded(true);
      }
    } catch {}
    setLoading(false);
  };

  return (
    <div className="sticky top-0 z-30 mx-3 sm:mx-6 pt-2 sm:pt-4 mb-1 sm:mb-2">
      <div className="bg-surface-900/30 sm:bg-surface-900/95 sm:backdrop-blur-md border border-surface-800/15 sm:border-surface-800/50 rounded-lg sm:rounded-xl overflow-hidden sm:shadow-lg sm:shadow-black/20">
        {/* Header — always visible */}
        <div className="flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2.5">
          <button
            onClick={() => session.summary ? setExpanded(!expanded) : handleSummarize()}
            className="flex items-center gap-2 flex-1 min-w-0 text-left"
          >
            <svg className={`w-3 h-3 sm:w-3.5 sm:h-3.5 text-surface-700 sm:text-surface-600 transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-[13px] sm:text-[14px] font-medium text-surface-600 sm:text-gray-400">
              {session.summary ? t('sessionSummary.title', { defaultValue: '대화 요약' }) : t('sessionSummary.empty', { defaultValue: '아직 요약이 없습니다.' })}
            </span>
          </button>

          {/* Meta chips */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {turnCount > 0 && (
              <span className="text-[12px] text-surface-700 sm:text-surface-600 sm:bg-surface-800/50 sm:px-1.5 sm:py-0.5 sm:rounded" title={t('sessionSummary.turns', { defaultValue: '대화 횟수' })}>
                {t('sessionSummary.turnCount', { defaultValue: '{{count}}회', count: turnCount })}
              </span>
            )}
            {filesCount > 0 && (
              <span className="text-[12px] text-surface-700 sm:text-surface-600 sm:bg-surface-800/50 sm:px-1.5 sm:py-0.5 sm:rounded" title={t('sessionSummary.files', { defaultValue: '수정한 파일' })}>
                {t('sessionSummary.fileCount', { defaultValue: '{{count}}개 파일', count: filesCount })}
              </span>
            )}
            {session.totalCost > 0 && (
              <span className="text-[12px] text-surface-700 sm:text-primary-400/70 sm:bg-primary-900/10 sm:px-1.5 sm:py-0.5 sm:rounded">
                ${session.totalCost.toFixed(3)}
              </span>
            )}
            {session.modelUsed && (
              <span className="hidden sm:inline text-[12px] text-purple-400/70 bg-purple-900/10 px-1.5 py-0.5 rounded">
                {session.modelUsed.replace('claude-', '').replace(/-\d+$/, '')}
              </span>
            )}
          </div>

          {/* Refresh button */}
          <button
            onClick={handleSummarize}
            disabled={loading}
            className="p-1 text-surface-700 sm:text-surface-600 hover:text-primary-400 transition-colors disabled:opacity-50 shrink-0"
            title={session.summary ? t('sessionSummary.refresh', { defaultValue: '요약 갱신' }) : t('sessionSummary.generate', { defaultValue: '요약 생성' })}
          >
            <svg className={`w-3 h-3 sm:w-3.5 sm:h-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {/* Expanded content */}
        {expanded && session.summary && (
          <div className="px-4 pb-3 border-t border-surface-800/30">
            {isStale && (
              <div className="tone-warning tone-text flex items-center gap-1.5 mt-2 mb-1.5 text-[12px] opacity-80">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span>{t('sessionSummary.stale', { defaultValue: '요약 이후 {{count}}회 더 대화했습니다.', count: turnCount - summaryAtTurn })}</span>
              </div>
            )}
            <div className="text-[14px] text-gray-400 leading-relaxed mt-2 space-y-1">
              {session.summary.split('\n').map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed) return null;
                // Arrow flow line — highlight
                if (trimmed.includes('→')) {
                  return <div key={i} className="text-primary-300/90 font-medium">{trimmed}</div>;
                }
                // Bullet line
                if (trimmed.startsWith('•') || trimmed.startsWith('-') || trimmed.startsWith('*')) {
                  return <div key={i} className="pl-1">{trimmed}</div>;
                }
                // Current status line
                if (trimmed.startsWith('Current:') || trimmed.startsWith('Status:')) {
                  return <div key={i} className="tone-success tone-text opacity-80 mt-1">{trimmed}</div>;
                }
                return <div key={i}>{trimmed}</div>;
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
