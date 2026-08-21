import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionMeta } from '@tower/shared';
import { InboxPanel } from '../inbox/InboxPanel';
import { ChallengeTimelinePanel } from './ChallengeTimelinePanel';
import { useSessionStore } from '../../stores/session-store';

interface WorkHubProps {
  onSelectSession?: (session: SessionMeta) => void;
}

export function WorkHub({ onSelectSession }: WorkHubProps) {
  const { t } = useTranslation('layout');
  const unreadResultCount = useSessionStore((state) => state.unreadSessions.size);
  const [mobileSection, setMobileSection] = React.useState<'attention' | 'progress'>(() => unreadResultCount > 0 ? 'attention' : 'progress');
  const mobileSectionChosen = React.useRef(false);

  React.useEffect(() => {
    if (!mobileSectionChosen.current && unreadResultCount > 0) setMobileSection('attention');
  }, [unreadResultCount]);

  const selectMobileSection = (section: 'attention' | 'progress') => {
    mobileSectionChosen.current = true;
    setMobileSection(section);
  };

  return (
    <div data-testid="work-hub" className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-y-contain bg-surface-950 md:overflow-hidden">
      <header className="shrink-0 border-b border-surface-800/80 bg-surface-950/95 px-4 py-4 backdrop-blur-xl md:px-5 md:py-5">
        <div className="mx-auto max-w-6xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-400">{t('workHub.eyebrow')}</p>
          <h1 className="mt-1 text-[21px] font-semibold tracking-tight text-surface-50 md:text-[25px]">{t('workHub.title')}</h1>
          <p className="mt-1 hidden max-w-2xl text-[13px] leading-5 text-surface-500 sm:block">{t('workHub.description')}</p>
        </div>
      </header>
      <nav className="sticky top-0 z-20 grid shrink-0 grid-cols-2 gap-1 border-b border-surface-800 bg-surface-950/95 p-2 backdrop-blur-xl lg:hidden" aria-label={t('workHub.mobileSections')}>
        <button
          type="button"
          aria-pressed={mobileSection === 'attention'}
          onClick={() => selectMobileSection('attention')}
          className={`min-h-10 rounded-lg px-3 text-[13px] font-semibold transition-colors ${mobileSection === 'attention' ? 'bg-primary-500/15 text-primary-300' : 'text-surface-500'}`}
        >
          {t('workHub.attentionTab')}
          {unreadResultCount > 0 && <span className="ml-1.5 rounded-full bg-primary-500/20 px-1.5 py-0.5 text-[10px] tabular-nums">{unreadResultCount > 99 ? '99+' : unreadResultCount}</span>}
        </button>
        <button
          type="button"
          aria-pressed={mobileSection === 'progress'}
          onClick={() => selectMobileSection('progress')}
          className={`min-h-10 rounded-lg px-3 text-[13px] font-semibold transition-colors ${mobileSection === 'progress' ? 'bg-primary-500/15 text-primary-300' : 'text-surface-500'}`}
        >
          {t('workHub.progressTab')}
        </button>
      </nav>
      <div className="min-h-0 flex-1 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        <main className={`${mobileSection === 'progress' ? 'block' : 'hidden'} min-w-0 lg:block lg:min-h-0`} aria-label={t('workHub.progressTab')}>
          <ChallengeTimelinePanel embedded />
        </main>
        <aside className={`${mobileSection === 'attention' ? 'block' : 'hidden'} min-w-0 border-surface-800/80 lg:block lg:min-h-0 lg:overflow-y-auto lg:border-l`} aria-label={t('workHub.attentionTab')}>
          <InboxPanel variant="work-results" onSelectSession={onSelectSession} />
        </aside>
      </div>
    </div>
  );
}
