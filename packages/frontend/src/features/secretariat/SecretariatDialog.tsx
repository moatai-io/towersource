import { SecretariatFace } from './SecretariatFace';
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function SecretariatDialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onNavigate = () => close.current();
    window.addEventListener('kanban-select-session', onNavigate);
    return () => { window.removeEventListener('kanban-select-session', onNavigate); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-2 backdrop-blur-[3px] sm:p-6" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={box} role="dialog" aria-modal="true" aria-label="비서실" tabIndex={-1}
      className="flex h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 shadow-2xl outline-none"
      onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        if (e.key === 'Tab') {
          const elements = box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], textarea:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]');
          if (!elements?.length) return;
          const first = elements[0], last = elements[elements.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }}>
      <div className="flex shrink-0 items-center justify-between border-b border-surface-700 px-5 py-3">
        <div className="flex items-center gap-3"><SecretariatFace className="h-16 w-16" /><div><p className="font-semibold text-surface-100">내 비서실</p><p className="mt-1 text-sm text-surface-400">하던 일은 그대로, 챙길 일은 함께.</p></div></div>
        <button className="min-h-11 rounded-lg px-3 text-sm text-surface-200 hover:bg-surface-800 focus-visible:outline" aria-label="비서실 닫기" onClick={onClose}>닫기 ✕</button>
      </div>
      <div className="min-h-0 flex flex-1 overflow-hidden">{children}</div>
    </div>
  </div>, document.body);
}
