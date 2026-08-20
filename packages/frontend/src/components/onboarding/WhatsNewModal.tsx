import { useTranslation } from 'react-i18next';
import { CHANGELOG, changelogLanguage } from '../../data/changelog';

interface Props {
  onClose: () => void;
}

export function WhatsNewModal({ onClose }: Props) {
  const { t, i18n } = useTranslation('common');
  const language = changelogLanguage(i18n.resolvedLanguage || i18n.language);
  const latest = CHANGELOG[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1a2e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-fade-in">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-white/10">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white/40 mb-1 font-mono">v{latest.version} · {latest.date}</p>
              <h2 className="text-2xl font-bold text-white">{latest.title[language]}</h2>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors text-xl leading-none"
              aria-label={t('close')}
            >
              ×
            </button>
          </div>
        </div>

        {/* Items */}
        <div className="px-6 py-5 space-y-3.5">
          {latest.items.map((item, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="text-xl leading-none mt-0.5 w-6 shrink-0 text-center">{item.emoji}</span>
              <p className="text-base text-white/80 leading-relaxed">{item.text[language]}</p>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-base font-semibold transition-colors"
          >
            {t('getStarted')} →
          </button>
        </div>
      </div>
    </div>
  );
}
