// Owns: reusable direct-drop host for Channel and AI teammate destinations. See README.md.
import React from 'react';
import { useConfirm } from '../../hooks/useDialog';
import { toastError, toastSuccess } from '../../utils/toast';
import { formatNamedItem } from '../../utils/korean-copy';
import {
  FILE_EXCHANGE_DRAG_TYPE,
  decodeExchangeDrag,
  transferFile,
  type ExchangeDestinationRef,
} from './fileExchange';

interface FileExchangeDropTargetProps {
  destination: ExchangeDestinationRef;
  label: string;
  onTransferred?: () => void | Promise<void>;
  className?: string;
  children: React.ReactNode;
}

/** Add one policy-aware File Exchange drop boundary without leaking transfer rules into host screens. */
export function FileExchangeDropTarget({ destination, label, onTransferred, className = '', children }: FileExchangeDropTargetProps) {
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
        if (!payload) return toastError('파일 전달 정보를 읽지 못했습니다.');
        setBusy(true);
        void transferFile(payload.source, destination, async plan => confirm({
          title: '파일 전달', message: plan.confirmationMessage || `파일 ${formatNamedItem(payload.name)}을 전달할까요?`, confirmLabel: '전달',
        })).then(async receipt => {
          if (!receipt) return;
          if (receipt.status !== 'completed') {
            toastError(receipt.status === 'stale' ? '원본이 변경되었습니다. 다시 드래그하세요.' : '현재 권한으로 전달할 수 없습니다.');
            return;
          }
          toastSuccess(`${payload.name} 전달 완료`);
          await onTransferred?.();
        }).catch(error => toastError(error instanceof Error ? error.message : '파일 전달에 실패했습니다.')).finally(() => setBusy(false));
      }}
    >
      {children}
      {(active || busy) && <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center rounded-xl border-2 border-dashed border-primary-400 bg-surface-950/88 p-5 text-center backdrop-blur-sm"><div><div className="text-[15px] font-semibold text-primary-200">{busy ? '파일을 전달하는 중…' : label}</div><div className="mt-1 text-[12px] text-surface-400">원본은 이동하지 않고 독립된 사본을 만듭니다.</div></div></div>}
    </div>
  );
}
