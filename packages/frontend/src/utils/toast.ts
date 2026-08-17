import { toast } from 'sonner';

/**
 * Toast priority policy:
 * - Low: inline/silent preferred; if needed, short bottom-right text.
 * - Medium: bottom-right toast.
 * - High: top-right error/warning that should interrupt attention.
 */
export function toastQuiet(message: string, opts?: { description?: string; action?: { label: string; onClick: () => void } }) {
  toast(message, {
    ...opts,
    position: 'bottom-right',
    duration: 2200,
  });
}

export function toastSuccess(message: string, opts?: { description?: string; action?: { label: string; onClick: () => void }; duration?: number }) {
  toast.success(message, { ...opts, position: 'bottom-right', duration: opts?.duration ?? 4200 });
}

export function toastError(message: string) {
  toast.error(message, { position: 'top-right' });
}

export function toastInfo(message: string, opts?: { description?: string; action?: { label: string; onClick: () => void }; duration?: number }) {
  toast.info(message, { ...opts, position: 'bottom-right', duration: opts?.duration ?? 5000 });
}

export function toastWarning(message: string) {
  toast.warning(message, { position: 'top-right' });
}
