// Owns: diff preview modal for inline-edit results. Public API: DiffPreview.
// See README.md.
//
// Visual design notes (2026-05-05 polish):
// - Frosted backdrop instead of opaque black: keeps the document visible
//   behind the modal so the user retains spatial context.
// - Header pairs a sparkle glyph with model + duration metadata; "변경 없음"
//   is surfaced as an inline pill rather than disabling the whole modal.
// - Before/After are equally weighted columns with a soft vertical divider.
//   "After" gets a slight tint + brighter text so the eye lands there first.
// - Apply is a glowing primary action; Cancel is a ghost button with a key
//   hint. The keyboard path (Enter to apply, Esc to cancel) is documented
//   in the footer.

import { useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { InlineEditState } from './useInlineEdit';

interface Props {
  state: InlineEditState;
}

function SparkleIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3z"
        fill="currentColor"
      />
      <path
        d="M19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7L19 14z"
        fill="currentColor"
        opacity="0.6"
      />
    </svg>
  );
}

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DiffPreview({ state }: Props) {
  const { t } = useTranslation('files');
  // Cmd/Ctrl + Enter → apply
  useEffect(() => {
    if (state.stage !== 'preview') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        state.apply();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.stage, state.apply]);

  if (state.stage !== 'preview' || !state.selection || state.replacement == null) return null;

  const unchanged = state.replacement === state.selection.text;
  const sizeBefore = state.selection.text.length;
  const sizeAfter = state.replacement.length;
  const sizeDelta = sizeAfter - sizeBefore;
  const sizeDeltaLabel = sizeDelta === 0 ? '±0' : sizeDelta > 0 ? `+${sizeDelta}` : `${sizeDelta}`;

  // Diagnostic hint when the AI returned the selection unchanged. The most
  // common cause we've seen in dogfood is users selecting only the inner
  // text of an element ("여기를 눌러보세요") and asking to delete the element
  // itself ("이 버튼 지워줘"). The AI can't reach outside SELECTION, so it
  // correctly bails. We surface a hint that nudges the user toward selecting
  // the element wrapper.
  const looksLikeDelete = /지워|없애|제거|삭제|빼|지움|remove|delete/i.test(state.instruction);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) state.cancel();
      }}
    >
      <div
        className="relative w-[min(960px,92vw)] max-h-[82vh] flex flex-col rounded-2xl border border-surface-600/70 bg-surface-800/95 backdrop-blur-xl shadow-2xl shadow-black/50 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* top edge highlight */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* Header — slim, drops model badge (lived in dogfood as visual noise). */}
        <div className="flex items-center gap-2 px-4 h-9 border-b border-surface-700/70">
          <SparkleIcon className="w-3.5 h-3.5 text-primary-400 shrink-0" />
          <div className="flex items-center gap-2 text-[14px] text-gray-100">
            <span>{t('aiEditPreview')}</span>
            {unchanged && (
              <span className="text-[12px] px-1.5 py-0.5 rounded-md tone-pill tone-warning">
                {t('noChanges')}
              </span>
            )}
          </div>

          <div className="flex-1" />

          <button
            onClick={() => state.cancel()}
            className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-surface-700/60 transition-colors"
            title={t('closeEsc')}
          >
            <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Diagnostic hint when unchanged — explains *why* in plain language
            and points the user at the next thing to try. */}
        {unchanged && (
          <div className="tone-card tone-warning px-5 py-3 border-b">
            <div className="flex items-start gap-2 text-[14px] tone-text opacity-90 leading-relaxed">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0 mt-0.5 tone-text" aria-hidden="true">
                <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4.5zm0 6a.75.75 0 100 1.5.75.75 0 000-1.5z" />
              </svg>
              <div>
                <div className="font-medium tone-text mb-0.5">{t('aiFoundNoChangesInSelection')}</div>
                <div className="tone-text opacity-70 text-[13px]">
                  {looksLikeDelete ? (
                    <Trans t={t} i18nKey="deleteSelectionHint" components={{ code: <span className="font-mono" />, strong: <span className="font-medium" />, markup: <span className="font-mono tone-text" /> }} />
                  ) : (
                    <>{t('retryWithLargerSelection')}</>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Body — two-column diff */}
        <div className="flex-1 grid grid-cols-2 min-h-0 divide-x divide-surface-700/60">
          <section className="flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-700/40">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
              <span className="text-[12px] uppercase tracking-[0.12em] text-gray-500 font-medium">Before</span>
              <span className="text-[12px] text-gray-600 ml-auto">{sizeBefore.toLocaleString()}자</span>
            </div>
            <pre className="flex-1 overflow-auto px-4 py-3 text-sm text-gray-300/90 whitespace-pre-wrap break-words font-mono leading-relaxed">
              {state.selection.text}
            </pre>
          </section>
          <section className="flex flex-col min-h-0 bg-primary-500/[0.03]">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-700/40">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-400 shadow-sm shadow-primary-400/60" />
              <span className="text-[12px] uppercase tracking-[0.12em] text-primary-300 font-medium">After</span>
              <span className="text-[12px] text-gray-600 ml-auto">
                {sizeAfter.toLocaleString()}자
                <span className={`ml-1.5 ${sizeDelta > 0 ? 'tone-success tone-text opacity-80' : sizeDelta < 0 ? 'tone-warning tone-text opacity-80' : 'text-gray-600'}`}>
                  {sizeDeltaLabel}
                </span>
              </span>
            </div>
            <pre className="flex-1 overflow-auto px-4 py-3 text-sm text-gray-50 whitespace-pre-wrap break-words font-mono leading-relaxed">
              {state.replacement}
            </pre>
          </section>
        </div>

        {/* Footer — tighter; shortcut hint shrunk to a single line. */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-surface-700/70 bg-surface-900/40">
          <div className="flex items-center gap-1 text-[11px] text-gray-500">
            <kbd className="px-1 py-px rounded bg-surface-700/50 font-mono">⌘↵</kbd>
            <span className="text-gray-600">{t('apply')}</span>
            <span className="opacity-40 mx-0.5">·</span>
            <kbd className="px-1 py-px rounded bg-surface-700/50 font-mono">Esc</kbd>
            <span className="text-gray-600">{t('cancel')}</span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => state.cancel()}
              className="px-3 py-1 text-[13px] rounded-md text-gray-300 hover:text-white hover:bg-surface-700/60 transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              onClick={state.apply}
              disabled={unchanged}
              className={`flex items-center gap-1 px-3 py-1 text-[13px] font-medium rounded-md transition-all
                ${unchanged
                  ? 'bg-surface-700/60 text-gray-500 cursor-not-allowed'
                  : 'bg-primary-500 hover:bg-primary-400 text-white shadow-md shadow-primary-500/30'}`}
            >
              <CheckIcon className="w-3 h-3" />
              <span>{t('apply')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
