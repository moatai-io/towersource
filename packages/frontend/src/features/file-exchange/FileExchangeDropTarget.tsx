// Owns: reusable direct-drop host for Channel and AI teammate destinations. See README.md.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../hooks/useDialog';
import { toastError, toastSuccess } from '../../utils/toast';
import { transferFile } from './fileExchange';
import {
  FILE_EXCHANGE_DRAG_TYPE,
  decodeExchangeDrag,
  type ExchangeDestinationRef,
} from './fileExchangeDrag';

interface FileExchangeDropTargetProps {
  destination: ExchangeDestinationRef;
  label: string;
  onTransferred?: () => void | Promise<void>;
  className?: string;
  children: React.ReactNode;
}

/** Add one policy-aware File Exchange drop boundary without leaking transfer rules into host screens. */
export function FileExchangeDropTarget({ destination, label, onTransferred, className = '', children }: FileExchangeDropTargetProps) {
  const { t } = useTranslation('files');
  const confirm = useConfirm();
  const [active, setActive] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const dragDepth = React.useRef(0);

  const isExchangeDrag = (event: React.DragEvent) => event.dataTransfer.types.includes(FILE_EXCHANGE_DRAG_TYPE);

  const reset = () => {
    dragDepth.current = 0;
    setActive(false);
  };

  return (
    <div
      className={`relative ${className}`}
      onDragEnter={(event) => {
        if (!isExchangeDrag(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setActive(true);
      }}
      onDragOver={(event) => {
        if (!isExchangeDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!isExchangeDrag(event)) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setActive(false);
      }}
      onDrop={(event) => {
        if (!isExchangeDrag(event)) return;
        event.preventDefault();
        const payload = decodeExchangeDrag(event.dataTransfer.getData(FILE_EXCHANGE_DRAG_TYPE));
        reset();
        if (!payload) return toastError(t('fileExchange.dragInvalid'));
        setBusy(true);
        void transferFile(payload.source, destination, async plan => confirm({
          title: t('fileExchange.transfer'), message: plan.confirmationMessage || t('fileExchange.dropConfirm', { name: t('fileExchange.namedItem', { name: payload.name }) }), confirmLabel: t('fileExchange.transfer'),
        })).then(async receipt => {
          if (!receipt) return;
          if (receipt.status !== 'completed') {
            toastError(receipt.status === 'stale' ? t('fileExchange.sourceChangedDrag') : t('fileExchange.permissionDenied'));
            return;
          }
          toastSuccess(t('fileExchange.transferDone', { name: payload.name }));
          await onTransferred?.();
        }).catch(error => toastError(error instanceof Error ? error.message : t('fileExchange.transferFailed'))).finally(() => setBusy(false));
      }}
    >
      {children}
      {(active || busy) && <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center rounded-xl border-2 border-dashed border-primary-400 bg-surface-950/88 p-5 text-center backdrop-blur-sm"><div><div className="text-[15px] font-semibold text-primary-200">{busy ? t('fileExchange.transferring') : label}</div><div className="mt-1 text-[12px] text-surface-400">{t('fileExchange.copyNotice')}</div></div></div>}
    </div>
  );
}
