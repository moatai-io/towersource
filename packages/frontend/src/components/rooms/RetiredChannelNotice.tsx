import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session-store';
import { useFileStore } from '../../stores/file-store';

/** Safe landing for preserved internal-channel links after the product surface retires. */
export function RetiredChannelNotice() {
  const { t } = useTranslation('rooms');
  const openWork = () => {
    useFileStore.getState().activateChatSlot();
    useSessionStore.getState().setActiveView('work');
    useSessionStore.getState().setSidebarOpen(false);
  };
  const openAiTeam = () => {
    useFileStore.getState().activateChatSlot();
    useSessionStore.getState().setAiNavigationSurface();
    useSessionStore.getState().setSidebarOpen(true);
  };

  return (
    <main className="relative z-10 flex flex-1 items-center justify-center overflow-y-auto px-5 py-10">
      <section aria-labelledby="retired-channel-title" className="w-full max-w-xl rounded-2xl border border-surface-700 bg-surface-900/95 p-6 shadow-xl sm:p-8">
        <div className="text-[12px] font-semibold uppercase tracking-[.12em] text-primary-300">{t('retiredChannel.eyebrow')}</div>
        <h1 id="retired-channel-title" className="mt-2 text-xl font-semibold text-surface-100 sm:text-2xl">{t('retiredChannel.title')}</h1>
        <p className="mt-3 text-sm leading-6 text-surface-300">
          {t('retiredChannel.description')}
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={openWork} className="min-h-11 rounded-lg bg-primary-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300">
            {t('retiredChannel.openWork')}
          </button>
          <button type="button" onClick={openAiTeam} className="min-h-11 rounded-lg border border-surface-600 px-4 py-2.5 text-sm font-semibold text-surface-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
            {t('retiredChannel.openAiTeam')}
          </button>
        </div>
      </section>
    </main>
  );
}
