/// <reference types="vite/client" />
// Owns: What's New / Changelog 패널 + NEW 뱃지 로직.
// Public API: WhatsNewPanel, hasUnseenWhatsNew, useUnseenWhatsNew.
// 정책: workspace/decisions/2026-05-07-whats-new-changelog.md
//
// Data source: docs/changelog/*.md (코드베이스). vite import.meta.glob 이
// build time 에 모든 markdown 을 string 으로 inline. symlink:
//   packages/frontend/src/changelog-data → ../../../docs/changelog
//
// 마지막 본 시각은 localStorage 에. 후속에서 user 테이블 컬럼으로 마이그레이션
// (멀티 디바이스 sync). 결정문 "마지막 본 시각 / NEW 뱃지" 섹션 참조.

import React from 'react';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import rehypeRaw from 'rehype-raw';
import { remarkGfmPlugin } from '../../utils/markdown-plugins';

const modules = import.meta.glob('../../changelog-data/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

type Entry = { slug: string; date: string; title: string; raw: string };

function parseEntries(): Entry[] {
  const entries: Entry[] = [];
  for (const [path, raw] of Object.entries(modules)) {
    const fileName = path.split('/').pop() || '';
    if (fileName.startsWith('_')) continue; // skip _template.md
    const slug = fileName.replace(/\.md$/, '');
    const dateMatch = slug.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const date = dateMatch[1];
    const titleMatch = raw.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : slug;
    entries.push({ slug, date, title, raw });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

const LAST_SEEN_KEY = 'whatsNew:lastSeenAt';

function getLastSeen(): string {
  try { return localStorage.getItem(LAST_SEEN_KEY) || ''; } catch { return ''; }
}
function setLastSeen(date: string) {
  try { localStorage.setItem(LAST_SEEN_KEY, date); } catch { /* ignore */ }
}

/** 햄버거 메뉴 / 메뉴 항목에서 NEW 뱃지 표시 여부 결정. */
export function hasUnseenWhatsNew(): boolean {
  const entries = parseEntries();
  if (entries.length === 0) return false;
  return entries[0].date > getLastSeen();
}

/** React 훅 — mount 시 한 번 평가. localStorage 변경엔 자동 반응 안 함 (간단). */
export function useUnseenWhatsNew(): boolean {
  const [unseen, setUnseen] = React.useState(false);
  React.useEffect(() => { setUnseen(hasUnseenWhatsNew()); }, []);
  return unseen;
}

interface WhatsNewPanelProps {
  onClose: () => void;
  onBack: () => void;
}

export function WhatsNewPanel({ onClose, onBack }: WhatsNewPanelProps) {
  const { t } = useTranslation('layout');
  const entries = React.useMemo(() => parseEntries(), []);
  const lastSeenAtMount = React.useRef(getLastSeen());
  // Default: 가장 최신 entry 펼쳐서 보여주기.
  const [expanded, setExpanded] = React.useState<string | null>(entries[0]?.slug || null);

  // 패널 열린 시점에 "마지막 본 시각" 갱신 — close 후엔 NEW 뱃지 안 뜸.
  React.useEffect(() => {
    if (entries[0]) setLastSeen(entries[0].date);
  }, [entries]);

  return (
    <div className="absolute left-0 top-full mt-2 w-[28rem] max-w-[calc(100vw-1rem)] max-h-[75vh] bg-surface-900 border border-surface-700 rounded-xl shadow-2xl shadow-black/40 overflow-hidden z-[100] flex flex-col">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-surface-800 flex items-center gap-2 shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 hover:bg-surface-800 rounded-lg transition-colors text-gray-400 hover:text-gray-200 active:scale-95"
          aria-label={t('common:back')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <svg className="w-3.5 h-3.5 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-[14px] font-semibold text-gray-300 flex-1">{t('whatsNew.title')}</span>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-surface-800 rounded-lg transition-colors text-gray-500 hover:text-gray-300 active:scale-95"
          aria-label={t('common:close')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body — entry list */}
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="p-6 text-center text-[14px] text-surface-500">
            {t('whatsNew.empty')}
          </div>
        ) : (
          <div className="divide-y divide-surface-800">
            {entries.map((entry) => {
              const isNew = entry.date > lastSeenAtMount.current;
              const isExpanded = expanded === entry.slug;
              return (
                <div key={entry.slug}>
                  <button
                    onClick={() => setExpanded(isExpanded ? null : entry.slug)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-800/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[12px] text-surface-500 font-mono">{entry.date}</span>
                        {isNew && (
                          <span className="tone-pill tone-success text-[10px] font-bold rounded px-1 py-px uppercase tracking-wide leading-none">
                            {t('whatsNew.newBadge')}
                          </span>
                        )}
                      </div>
                      <div className="text-[14px] text-gray-200 truncate">{entry.title}</div>
                    </div>
                    <svg
                      className={`w-3 h-3 text-surface-500 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3 pt-1 prose prose-invert prose-sm max-w-none text-[14px] [&_h1]:hidden [&_h2]:text-[15px] [&_h2]:mt-3 [&_h2]:mb-1.5 [&_p]:my-1.5 [&_table]:text-[13px] [&_code]:text-[13px]">
                      <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} rehypePlugins={[rehypeRaw]}>{entry.raw}</ReactMarkdown>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
