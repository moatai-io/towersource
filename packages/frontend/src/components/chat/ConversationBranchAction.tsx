import { useTranslation } from 'react-i18next';

export function ConversationBranchAction({ onEditRequested }: { sessionId?: string; messageId?: string; onEditRequested?: () => void }) {
  const { t } = useTranslation('chat');
  return <button
    type="button"
    onClick={onEditRequested}
    aria-label={t('edit')}
    title={t('edit')}
    className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-surface-500 transition-colors hover:bg-surface-800 hover:text-surface-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:min-h-10 sm:min-w-10 md:min-w-fit md:shrink-0"
  >
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </svg>
    <span className="hidden whitespace-nowrap text-[12px] font-medium md:inline">{t('edit')}</span>
  </button>;
}
