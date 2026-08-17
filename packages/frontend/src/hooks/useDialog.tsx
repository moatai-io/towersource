/**
 * useDialog — imperative confirm() / prompt() replacement for Tower.
 *
 * Owns: <DialogProvider /> mount + useConfirm() / usePrompt() hooks that
 * resolve a Promise the call site can `await`.
 *
 * Public API:
 *   const confirm = useConfirm();
 *   if (await confirm({ title, message, danger: true })) { ... }
 *
 *   const prompt = usePrompt();
 *   const reason = await prompt({ title, message, placeholder });
 *   if (reason === null) return; // cancelled
 *
 * Why: window.confirm() / window.prompt() get permanently suppressed by the
 * browser the moment the user checks "이 페이지에서 추가 대화상자를 표시하지
 * 않도록 설정". Production users hit that footgun and silently lose the
 * destructive-action confirm path. This hook routes through a custom dialog
 * component that the browser cannot suppress.
 *
 * Concurrent calls are queued — only one dialog is visible at a time, the
 * next opens after the previous resolves. This matches native confirm's
 * single-modal semantics.
 *
 * See: workspace/decisions/2026-05-05-no-native-dialogs.md
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog, type ConfirmVariant } from '../components/common/ConfirmDialog';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' = red confirm button for destructive actions. */
  variant?: ConfirmVariant;
  /** Convenience alias for variant: 'danger'. */
  danger?: boolean;
}

export interface PromptOptions {
  title?: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface DialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

interface QueuedDialog {
  id: number;
  kind: 'confirm' | 'prompt';
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  placeholder?: string;
  initialValue?: string;
  resolveConfirm?: (value: boolean) => void;
  resolvePrompt?: (value: string | null) => void;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<QueuedDialog | null>(null);
  const queueRef = useRef<QueuedDialog[]>([]);
  const idRef = useRef(0);

  const popNext = useCallback(() => {
    const next = queueRef.current.shift();
    setCurrent(next ?? null);
  }, []);

  const enqueue = useCallback(
    (entry: Omit<QueuedDialog, 'id'>) => {
      const full: QueuedDialog = { ...entry, id: ++idRef.current };
      // Use functional update to avoid stale-closure on `current`.
      setCurrent((prev) => {
        if (prev) {
          queueRef.current.push(full);
          return prev;
        }
        return full;
      });
    },
    [],
  );

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        enqueue({
          kind: 'confirm',
          title: options.title,
          message: options.message,
          confirmLabel: options.confirmLabel,
          cancelLabel: options.cancelLabel,
          variant: options.danger ? 'danger' : options.variant ?? 'default',
          resolveConfirm: resolve,
        });
      }),
    [enqueue],
  );

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        enqueue({
          kind: 'prompt',
          title: options.title,
          message: options.message,
          confirmLabel: options.confirmLabel,
          cancelLabel: options.cancelLabel,
          placeholder: options.placeholder ?? '',
          initialValue: options.initialValue ?? '',
          resolvePrompt: resolve,
        });
      }),
    [enqueue],
  );

  const value = useMemo<DialogContextValue>(() => ({ confirm, prompt }), [confirm, prompt]);

  const handleResolve = useCallback(
    (confirmed: boolean) => {
      if (!current) return;
      // Confirm-mode dialogs resolve here; prompt-mode dialogs already resolved
      // their value via onPromptResolve, so we just need to advance the queue.
      if (current.kind === 'confirm' && current.resolveConfirm) {
        current.resolveConfirm(confirmed);
      }
      popNext();
    },
    [current, popNext],
  );

  const handlePromptResolve = useCallback(
    (text: string | null) => {
      if (!current || current.kind !== 'prompt') return;
      current.resolvePrompt?.(text);
    },
    [current],
  );

  return (
    <DialogContext.Provider value={value}>
      {children}
      {current && (
        <ConfirmDialog
          key={current.id}
          title={current.title}
          message={current.message}
          confirmLabel={current.confirmLabel}
          cancelLabel={current.cancelLabel}
          variant={current.variant}
          promptPlaceholder={current.kind === 'prompt' ? current.placeholder ?? '' : null}
          promptInitialValue={current.initialValue ?? ''}
          onResolve={handleResolve}
          onPromptResolve={handlePromptResolve}
        />
      )}
    </DialogContext.Provider>
  );
}

function useDialogContext(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useConfirm/usePrompt must be used inside <DialogProvider>');
  }
  return ctx;
}

export function useConfirm() {
  return useDialogContext().confirm;
}

export function usePrompt() {
  return useDialogContext().prompt;
}
