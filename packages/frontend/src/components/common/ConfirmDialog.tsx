/**
 * ConfirmDialog — drop-in replacement for window.confirm() / window.prompt().
 *
 * Owns: pure presentational dialog (overlay + panel + Esc/Enter handling).
 * Public API: <ConfirmDialog />, used by DialogProvider.
 *
 * Why this exists: Chromium suppresses window.confirm() permanently after the
 * user checks "이 페이지에서 추가 대화상자를 표시하지 않도록 설정" — an
 * unrecoverable footgun on prod. Custom dialog dodges that suppression and
 * gives us control over keyboard, focus, and visual variant (danger vs default).
 *
 * See: workspace/decisions/2026-05-05-no-native-dialogs.md
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ConfirmVariant = 'default' | 'danger';

export interface ConfirmDialogProps {
  /** Dialog title (bold header line). */
  title?: string;
  /** Body message. Plain text — newlines are preserved via whitespace-pre-line. */
  message: string;
  /** Confirm button label. Default '확인'. */
  confirmLabel?: string;
  /** Cancel button label. Default '취소'. */
  cancelLabel?: string;
  /** 'danger' renders the confirm button red — for destructive actions. */
  variant?: ConfirmVariant;
  /** When non-null, dialog acts as a prompt (text input). The string is the placeholder. */
  promptPlaceholder?: string | null;
  /** Initial value for prompt mode. */
  promptInitialValue?: string;
  /** Called with true (confirmed) or false (cancelled). For prompt mode, value is in onPromptResolve. */
  onResolve: (confirmed: boolean) => void;
  /** Prompt-mode resolver: called with the entered string, or null if cancelled. */
  onPromptResolve?: (value: string | null) => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  promptPlaceholder = null,
  promptInitialValue = '',
  onResolve,
  onPromptResolve,
}: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  const resolvedConfirmLabel = confirmLabel ?? t('confirm');
  const resolvedCancelLabel = cancelLabel ?? t('cancel');
  const isPrompt = promptPlaceholder !== null;
  const [value, setValue] = useState(promptInitialValue);
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  // Focus the input (prompt mode) or the confirm button (confirm mode) on mount.
  useEffect(() => {
    const target = isPrompt ? inputRef.current : confirmButtonRef.current;
    target?.focus();
    if (isPrompt) inputRef.current?.select();
  }, [isPrompt]);

  // Esc → cancel, Enter → confirm (Enter also submits prompt).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // Skip if focus is on cancel button, so the user can keyboard-cancel.
        const active = document.activeElement as HTMLElement | null;
        if (active?.dataset?.dialogRole === 'cancel') return;
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = () => {
    if (isPrompt) onPromptResolve?.(value);
    onResolve(true);
  };
  const cancel = () => {
    if (isPrompt) onPromptResolve?.(null);
    onResolve(false);
  };

  const confirmButtonClasses =
    variant === 'danger'
      ? 'bg-red-600 hover:bg-red-500 text-white'
      : 'bg-primary-600 hover:bg-primary-500 text-white';

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      onClick={(e) => {
        // Click outside panel = cancel (matches native confirm Esc behaviour).
        if (e.target === overlayRef.current) cancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'confirm-dialog-title' : undefined}
    >
      <div className="bg-surface-800 border border-surface-700 rounded-xl shadow-2xl w-[420px] max-w-[90vw]">
        <div className="p-4 space-y-3">
          {title && (
            <h2 id="confirm-dialog-title" className="text-[15px] font-semibold text-white">
              {title}
            </h2>
          )}
          <p className="text-[14px] text-gray-300 whitespace-pre-line leading-relaxed">{message}</p>
          {isPrompt && (
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={promptPlaceholder ?? undefined}
              className="w-full bg-surface-900 border border-surface-600 rounded-lg px-3 py-2 text-[14px] text-white focus:outline-none focus:border-primary-500"
            />
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-surface-700">
          <button
            type="button"
            data-dialog-role="cancel"
            onClick={cancel}
            className="px-3 py-1.5 rounded-lg border border-surface-600 hover:border-surface-500 text-gray-300 text-[14px] font-medium transition-colors"
          >
            {resolvedCancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            data-dialog-role="confirm"
            onClick={confirm}
            className={`px-3 py-1.5 rounded-lg text-[14px] font-medium transition-colors ${confirmButtonClasses}`}
          >
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
