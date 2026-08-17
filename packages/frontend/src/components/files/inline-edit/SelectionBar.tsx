// Owns: floating bar above a text selection. Public API: SelectionBar.
// See README.md.
//
// Visual design notes (2026-05-05 polish):
// - Glassmorphic panel (backdrop-blur + translucent bg) so the underlying
//   selection stays visible — preserves the user's mental anchor.
// - Sparkle glyph instead of a text "AI" badge: more compact, on-brand for
//   AI-augmented surfaces, and avoids drawing the eye away from the input.
// - Submit is an icon-only arrow inside the input row (Linear/Notion pattern);
//   keyboard (Enter / Esc) is the primary action path, mouse is fallback.
// - Suggestion chips appear only when the input is empty, and disappear once
//   the user starts typing — they're scaffolding, not permanent UI.
//
// Phase 1.5h (2026-05-05) minimalisation — option C:
// - Edit-mode picker (교체 / 앞에 / 뒤에) removed. 90% of usage is replace;
//   insertBefore/insertAfter can be expressed as instructions if needed
//   ("앞에 ___ 추가해줘"). Backend SYSTEM_PROMPT_HTML_INSERT remains as
//   dead-code in case the picker is reintroduced via a future toggle.
// - Scope pill row (선택 영역 / `<tag>` 통째) removed. Replaced by direct
//   manipulation: clicking an outline label inside the iframe toggles
//   scope. SelectionBar is now strictly: input + chips + footer.

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { InlineEditState } from './useInlineEdit';

interface Props {
  state: InlineEditState;
}

const SUGGESTIONS: { labelKey: string; instructionKey: string }[] = [
  { labelKey: 'formal', instructionKey: 'formalInstruction' },
  { labelKey: 'concise', instructionKey: 'conciseInstruction' },
  { labelKey: 'simplify', instructionKey: 'simplifyInstruction' },
  { labelKey: 'natural', instructionKey: 'naturalInstruction' },
  {
    labelKey: 'factCheck',
    instructionKey: 'factCheckInstruction',
    // The agent has no web access — we frame the task as "flag/fix obvious
    // factual errors using your existing knowledge, otherwise leave it alone"
    // so the conservative default (Rule 9: ambiguous → unchanged) kicks in
    // instead of inviting confident hallucination.
  },
  {
    labelKey: 'improveConsistency',
    instructionKey: 'consistencyInstruction',
    // The system prompt already tells the model to match surrounding tone
    // (Rule 7) — this chip surfaces that as an explicit user-visible action.
  },
];

function SparkleIcon({ className = '' }: { className?: string }) {
  // Compact 4-point sparkle. Slight asymmetry makes it feel less "logo-ish".
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

function ArrowSubmitIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path
        d="M4 10h12M11 5l5 5-5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M10 3a7 7 0 017 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SelectionBar({ state }: Props) {
  const { t } = useTranslation('files');
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if ((state.stage === 'prompting' || state.stage === 'loading') && inputRef.current) {
      inputRef.current.focus();
    }
  }, [state.stage]);

  // Dismiss when the user clicks anywhere outside the bar. We listen on the
  // document so iframe-internal clicks (which bubble up through postMessage
  // CLEAR, handled by HtmlInlineEditSurface) and parent-page clicks both
  // route through cancel(). The instruction is preserved as a draft by
  // useInlineEdit, so the user gets it back on their next selection.
  useEffect(() => {
    if (state.stage !== 'prompting' && state.stage !== 'error') return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target || !barRef.current) return;
      if (barRef.current.contains(target)) return;
      // Don't dismiss while a request is in flight or the diff is open —
      // those have their own lifecycle.
      if (state.stage === 'loading' || state.stage === 'preview') return;
      state.cancel();
    };
    // Use mousedown (not click) so we dismiss before a fresh selection
    // mouseup can race against us and immediately re-open.
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [state.stage, state.cancel]);

  if (state.stage !== 'prompting' && state.stage !== 'loading' && state.stage !== 'error') return null;
  if (!state.selection) return null;

  const rect = state.selection.rect;
  const BAR_WIDTH = 460;
  // Comfortable breathing room — keeps the bar visually "below" rather
  // than glued to the selection's last line. Long selections still anchor
  // to rect.bottom so the bar slides further down with longer drags.
  const BAR_GAP = 24;
  // Slimmed dimensions (padding cuts brought every row down ~4px).
  // Phase 1.5h removed mode picker + scope pill rows — input row is the
  // only fixed component now, with chips/error appearing conditionally.
  const HEIGHT_HINT = state.instruction ? 44 : 76; // includes chip row when empty

  // Position priority — *below* the selection by default. Reasoning:
  // the user just *read* the text above their selection (that's how they got
  // here); the area below is the unread continuation. Putting the bar above
  // would cover the just-read context and feel disorienting (dogfood report).
  // Fall back to "above" only when there isn't enough room below the viewport.
  //
  // For multi-line selections, `rect` is the FIRST line only; placing
  // "below" using rect.height would land the bar on the second line and
  // cover it. `bottomMost` is the bottom of the LAST rect of the range, so
  // the bar slides past the entire selection. We fall back to rect+height
  // when bottomMost is missing (e.g. legacy callers).
  const selectionBottom = state.selection.bottomMost ?? rect.top + rect.height;
  const aboveTop = rect.top - HEIGHT_HINT - BAR_GAP;
  const belowTop = selectionBottom + BAR_GAP;
  const fitsBelow = belowTop + HEIGHT_HINT < window.innerHeight - 8;
  const fitsAbove = aboveTop > 8;
  const finalTop = fitsBelow
    ? belowTop
    : fitsAbove
    ? aboveTop
    // Both sides cramped — clamp inside viewport, prefer below.
    : Math.max(8, Math.min(belowTop, window.innerHeight - HEIGHT_HINT - 8));
  const left = Math.max(8, Math.min(window.innerWidth - BAR_WIDTH - 8, rect.left));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (state.stage !== 'loading' && state.instruction.trim()) state.submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      state.cancel();
    }
  };

  const showChips = state.stage === 'prompting' && !state.instruction;
  const isLoading = state.stage === 'loading';
  const canSubmit = !isLoading && state.instruction.trim().length > 0;

  return (
    <div
      ref={barRef}
      className="fixed z-50 select-none"
      style={{ top: finalTop, left, width: BAR_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="relative rounded-xl border border-surface-600/70 bg-surface-800/85 backdrop-blur-xl shadow-2xl shadow-black/40 overflow-hidden">
        {/* subtle top edge highlight — gives the panel a sense of being lit from above */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* Input row */}
        <div className="flex items-center gap-2 px-3 py-1.5">
          <SparkleIcon className={`w-4 h-4 shrink-0 ${isLoading ? 'text-primary-300 animate-pulse' : 'text-primary-400'}`} />
          <input
            ref={inputRef}
            type="text"
            value={state.instruction}
            onChange={(e) => state.setInstruction(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('howShouldThisChange')}
            disabled={isLoading}
            maxLength={500}
            className="flex-1 min-w-0 bg-transparent text-base text-gray-100 placeholder-gray-500 outline-none disabled:opacity-60"
          />

          {/* Submit — icon-only, glow when ready */}
          <button
            onClick={() => canSubmit && state.submit()}
            disabled={!canSubmit}
            title={canSubmit ? t('applyEditEnter') : t('enterInstruction')}
            className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-lg transition-all
              ${canSubmit
                ? 'bg-primary-500 hover:bg-primary-400 text-white shadow-lg shadow-primary-500/30'
                : 'bg-surface-700/70 text-gray-500 cursor-not-allowed'}`}
          >
            {isLoading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <ArrowSubmitIcon className="w-4 h-4" />}
          </button>

          {/* Close — ghost, only visible on hover of the panel */}
          <button
            onClick={() => state.cancel()}
            title={t('cancelEsc')}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-gray-500 hover:text-gray-200 hover:bg-surface-700/60 transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Suggestion chips — only when input is empty (scaffolding) */}
        {showChips && (
          <div className="flex flex-wrap gap-1 px-3 pb-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.labelKey}
                onClick={() => {
                  const instruction = t(s.instructionKey);
                  state.setInstruction(instruction);
                  void state.submit(instruction);
                }}
                className="text-[13px] px-2 py-1 rounded-md bg-surface-700/60 hover:bg-surface-600/80 text-gray-300 hover:text-white transition-colors"
              >
                {t(s.labelKey)}
              </button>
            ))}
          </div>
        )}

        {/* Error inline */}
        {state.stage === 'error' && state.error && (
          <div className="flex items-start gap-1.5 px-3 pb-1.5 text-[13px] text-red-300/90">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true">
              <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4.5zm0 6a.75.75 0 100 1.5.75.75 0 000-1.5z" />
            </svg>
            <span className="leading-snug">{state.error}</span>
          </div>
        )}

        {/* Slim footer — keyboard hints + persistent undo (when applicable).
            The 5-second sonner toast post-apply is the *primary* surface for
            "I just clicked apply, let me take it back"; this footer affordance
            is the *durable* one — visible on every subsequent selection on the
            same file as long as snapshots remain in the per-file undo stack. */}
        {state.stage !== 'error' && (
          <div className="flex items-center justify-between gap-2 px-3 py-0.5 border-t border-surface-700/70 bg-surface-900/30 text-[11px] text-gray-500">
            {state.canUndo ? (
              <button
                onClick={async () => { await state.undoLast(); }}
                title={t('undoLastAiEdit')}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-gray-400 hover:text-white hover:bg-surface-700/60 transition-colors"
              >
                <span aria-hidden>↶</span>
                <span>{t('undo')}</span>
                <kbd className="ml-0.5 px-1 py-px rounded bg-surface-700/50 text-gray-400 font-mono text-[11px]">⌘Z</kbd>
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-1">
              <kbd className="px-1 py-px rounded bg-surface-700/50 font-mono">↵</kbd>
              <span className="text-gray-600">{t('apply')}</span>
              <span className="opacity-40 mx-0.5">·</span>
              <kbd className="px-1 py-px rounded bg-surface-700/50 font-mono">Esc</kbd>
              <span className="text-gray-600">{t('close')}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
