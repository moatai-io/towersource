import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@tower/shared';
import { AgentIdentityAvatar } from '../agent-profile/AgentIdentityAvatar';
import { useSessionStore } from '../../stores/session-store';
import { hasSeenTowerGuide, markTowerGuideSeen, TOUR_STATE_CHANGED_EVENT } from '../../tours/tourState';
import type { WelcomeContent } from './useSessionWelcome';

export function SessionWelcome({ project, content, isLoading = false, onStart, onInteraction }: {
  project: Project | null;
  content: WelcomeContent | null;
  isLoading?: boolean;
  onStart: (message: string) => void;
  onInteraction: () => void;
}) {
  const { t, i18n } = useTranslation('chat');
  const korean = (i18n.resolvedLanguage || i18n.language).startsWith('ko');
  const sessions = useSessionStore((s) => s.sessions);
  const [guideSeen, setGuideSeen] = useState(() => hasSeenTowerGuide());
  const currentUsername = typeof window !== 'undefined' ? localStorage.getItem('username') : null;
  const hasOwnSession = !!currentUsername && sessions.some((session) => session.ownerUsername === currentUsername);
  const shouldShowGuideCta = !guideSeen || !hasOwnSession;
  useEffect(() => {
    const update = () => setGuideSeen(hasSeenTowerGuide());
    window.addEventListener(TOUR_STATE_CHANGED_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(TOUR_STATE_CHANGED_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);

  const name = project?.agent?.displayName || t('welcome.defaultName');
  const choices = content?.choices || [0, 1, 2].map((index) => ({
    label: t(`welcome.choices.${index}.label`),
    message: t(`welcome.choices.${index}.message`),
  }));
  const start = (message: string) => {
    onInteraction();
    onStart(message);
  };

  return (
    <section aria-label={t('welcome.regionLabel')} className="flex-1 overflow-y-auto px-4 md:px-6">
      <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center py-8 md:py-12">
        <div className="flex items-center gap-3">
          {project ? <AgentIdentityAvatar project={project} className="h-16 w-16 shrink-0" /> : (
            <span aria-hidden="true" className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-surface-800 text-2xl">✦</span>
          )}
          <h2 className="text-lg font-semibold text-gray-100">{name}</h2>
        </div>
        <div className="mt-5 rounded-2xl rounded-tl-sm border border-surface-700/60 bg-surface-800/40 px-5 py-4">
          {isLoading && (
            <div role="status" aria-live="polite" className="mb-3 flex items-start gap-2 text-sm leading-relaxed text-gray-400">
              <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-current motion-safe:animate-pulse" />
              <p>{korean ? '최근에 나눈 이야기와 진행한 일을 살펴보고 있어요. 이어서 이야기할 만한 주제를 생각해볼게요. 먼저 말씀해 주셔도 좋습니다.' : 'I’m reviewing recent conversations and work for useful topics to pick up. You can start talking right away.'}</p>
            </div>
          )}
          {content?.contextLine && <p className="mb-3 text-base leading-7 text-gray-300">{content.contextLine}</p>}
          <p className="text-lg leading-relaxed text-gray-100">{content?.question || t('welcome.question')}</p>
        </div>
        <div className="mt-4 flex flex-col items-end gap-2" aria-label={t('welcome.choicesLabel')}>
          {choices.map((choice, index) => (
            <button key={`${index}:${choice.label}`} type="button" onClick={() => start(choice.message)}
              className="max-w-full rounded-2xl rounded-br-sm border border-surface-700 bg-surface-900/60 px-4 py-3 text-left text-sm leading-relaxed text-gray-200 transition-colors hover:border-primary-500/50 hover:bg-primary-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
              {choice.label}
            </button>
          ))}
        </div>
        <p className="mt-4 text-sm leading-relaxed text-gray-400">{t('welcome.freeInput')}</p>
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-surface-700/50 pt-4">
          {shouldShowGuideCta && (
            <button type="button" onClick={() => { onInteraction(); window.dispatchEvent(new CustomEvent('tower-start-tour', { detail: { tourId: 'beginner' } })); }}
              className="rounded-full border border-primary-500/30 bg-primary-500/10 px-3.5 py-2 text-[13px] font-medium text-primary-300 hover:bg-primary-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
              {t('emptyState.startGuide')}
            </button>
          )}
          <button type="button" onClick={() => { markTowerGuideSeen(); start('/tower-intro'); }}
            className="rounded-full border border-surface-700/70 px-3.5 py-2 text-[13px] text-gray-300 hover:bg-surface-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
            {t('emptyState.askInChat')}
          </button>
        </div>
      </div>
    </section>
  );
}
