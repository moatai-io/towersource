import { useTranslation } from 'react-i18next';

export function InvalidLinkPage() {
  const { t } = useTranslation('layout');

  return (
    <main className="grid min-h-dvh place-items-center bg-surface-950 px-6 text-surface-100">
      <section className="w-full max-w-lg rounded-2xl border border-surface-800 bg-surface-900 p-8 text-center shadow-xl">
        <div className="text-sm font-semibold text-primary-300">404</div>
        <h1 className="mt-2 text-2xl font-semibold">{t('invalidLinkTitle')}</h1>
        <p className="mt-3 text-sm leading-6 text-surface-400">{t('invalidLinkMessage')}</p>
        <a
          href="/"
          className="mt-6 inline-flex rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-400"
        >
          {t('invalidLinkHome')}
        </a>
      </section>
    </main>
  );
}
