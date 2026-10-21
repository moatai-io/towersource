import { useTranslation } from 'react-i18next';
import type { SessionLinkState } from '../../hooks/session-link-resolution';

const copyKeys = {
  forbidden: ['sessionAccessDeniedTitle', 'sessionAccessDeniedMessage'],
  not_found: ['requestedSessionNotFoundTitle', 'requestedSessionNotFoundMessage'],
  authentication_required: ['sessionAuthenticationRequiredTitle', 'sessionAuthenticationRequiredMessage'],
  unavailable: ['sessionUnavailableTitle', 'sessionUnavailableMessage'],
  archived: ['sessionArchivedLinkTitle', 'sessionArchivedLinkMessage'],
  loading: ['sessionLinkLoadingTitle', 'sessionLinkLoadingMessage'],
} as const;

export function SessionLinkNotice({ state, onOpenArchive }: { state: SessionLinkState; onOpenArchive: () => void }) {
  const { t } = useTranslation('layout');
  const [title, message] = copyKeys[state.kind];
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-surface-950 px-6" role="status" aria-live="polite" data-testid="session-link-notice">
      <section className="w-full max-w-lg rounded-2xl border border-surface-800 bg-surface-900 p-8 text-center shadow-xl">
        <h1 className="text-xl font-semibold text-surface-100">{t(title)}</h1>
        <p className="mt-3 text-sm leading-6 text-surface-400">{t(message)}</p>
        {state.kind !== 'loading' && <div className="mt-6 flex flex-wrap justify-center gap-3">
          {state.kind === 'archived' && <button type="button" onClick={onOpenArchive} className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-400">{t('archivedSessionsTitle')}</button>}
          <a href="/" className="rounded-lg border border-surface-700 px-4 py-2 text-sm font-semibold text-surface-100 hover:bg-surface-800">{t('invalidLinkHome')}</a>
        </div>}
      </section>
    </div>
  );
}
