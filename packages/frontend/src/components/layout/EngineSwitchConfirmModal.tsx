import { Trans, useTranslation } from 'react-i18next';

/**
 * Confirmation dialog shown before a lossy engine hard switch.
 *
 * Triggered from ModelSelectorInline when the user picks a model from a
 * different engine than the active session AND that session has real history.
 * On confirm, the caller POSTs /api/sessions/:id/switch-engine (rehydrate +
 * guards). See workspace/decisions/2026-05-19-engine-hard-switch-design.md.
 *
 * Lossy-by-design messaging is deliberate (decision §"핵심 원칙" #3): the
 * user must understand that the previous engine's reasoning traces do not
 * carry over, while messages and tool calls do.
 */
export interface EngineSwitchConfirmModalProps {
  fromEngine: string;
  toEngine: string;
  /** Disable buttons + show spinner while the switch request is in flight. */
  busy?: boolean;
  /** Non-null when the last attempt failed — rendered as an inline error. */
  errorMessage?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const ENGINE_LABEL: Record<string, string> = {
  claude: 'Claude',
  pi: 'Pi',
  local: 'Local',
};

function label(engine: string): string {
  return ENGINE_LABEL[engine] ?? engine;
}

export function EngineSwitchConfirmModal({
  fromEngine,
  toEngine,
  busy = false,
  errorMessage = null,
  onConfirm,
  onCancel,
}: EngineSwitchConfirmModalProps) {
  const { t } = useTranslation('layout');
  const nextEngine = label(toEngine);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-[min(440px,92vw)] rounded-xl border border-surface-700/60 bg-surface-850 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xl">🔀</span>
          <h2 className="text-[17px] font-semibold text-gray-100">{t('switchEngine')}</h2>
        </div>

        <div className="flex items-center gap-2 mb-4 text-[15px]">
          <span className="px-2 py-1 rounded-md bg-surface-800 border border-surface-700/60 text-gray-300">
            {label(fromEngine)}
          </span>
          <svg className="w-4 h-4 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
          <span className="px-2 py-1 rounded-md bg-primary-500/15 border border-primary-500/30 text-primary-300">
            {label(toEngine)}
          </span>
        </div>

        <p className="text-[15px] leading-relaxed text-gray-400 mb-2">
          <Trans i18nKey="layout:engineSwitchDescription" values={{ engine: nextEngine }} components={{ strong: <strong className="text-gray-200" /> }} />
        </p>
        <ul className="text-[14px] leading-relaxed text-gray-500 mb-4 space-y-1 list-disc pl-4">
          <li><Trans i18nKey="layout:engineSwitchPreserves" components={{ strong: <span className="text-gray-300" /> }} /></li>
          <li><Trans i18nKey="layout:engineSwitchDropsThinking" components={{ strong: <span className="text-gray-300" /> }} /></li>
          <li>{t('engineSwitchFirstResponseSlow')}</li>
        </ul>

        {errorMessage && (
          <div className="mb-3 px-3 py-2 rounded-md bg-rose-500/10 border border-rose-500/30 text-[14px] text-rose-300">
            {errorMessage}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-[15px] text-gray-300 bg-surface-800 border border-surface-700/60 hover:bg-surface-750 disabled:opacity-50 transition-colors"
          >
            {t('common:cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-[15px] font-medium text-white bg-primary-600 hover:bg-primary-500 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
          >
            {busy && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            )}
            {busy ? t('switchingEngine') : t('switchEngineAction')}
          </button>
        </div>
      </div>
    </div>
  );
}
