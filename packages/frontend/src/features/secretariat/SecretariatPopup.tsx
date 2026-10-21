import { SecretariatFace } from './SecretariatFace';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from '../../stores/session-store';
import { loadSecretariat, respondSecretariat, type SecretariatProposal } from './secretariat-api';

export function popupBlocked(): boolean {
  const focused = document.activeElement as HTMLElement | null;
  return document.visibilityState !== 'visible'
    || !!document.querySelector('[role="dialog"]:not([data-secretariat-popup]), [aria-modal="true"]:not([data-secretariat-popup]), dialog[open], .fixed.inset-0:not([data-secretariat-overlay])')
    || !!focused?.matches('input, textarea, select, [contenteditable="true"]')
    || useSessionStore.getState().streamingSessions.size > 0;
}

export function SecretariatPopup() {
  const [proposal, setProposal] = useState<SecretariatProposal | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const current = useRef<SecretariatProposal | null>(null);
  current.current = proposal;
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let lastFetch = 0;
    let reserved: SecretariatProposal | null = null;
    const check = async () => {
      if (pending || current.current || popupBlocked()) return;
      if (reserved) { setProposal(reserved); reserved = null; return; }
      if (Date.now() - lastFetch < 60_000) return;
      lastFetch = Date.now();
      pending = true;
      try {
        const snapshot = await loadSecretariat(controller.signal);
        const next = snapshot.enabled && snapshot.proposals.find(p => !p.readAt && !p.shownAt && p.delivery !== 'inbox');
        if (!next || popupBlocked()) return;
        await respondSecretariat(next.id, 'show', controller.signal);
        if (!controller.signal.aborted) {
          if (popupBlocked()) reserved = next; else setProposal(next);
        }
      } catch { /* Offline/disabled/unavailable is silent; no model calls from this poll. */ }
      finally { pending = false; }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!proposal) return;
    const previous = document.activeElement as HTMLElement | null;
    setExpanded(false);
    dialog.current?.focus();
    const timer = window.setInterval(() => {
      if (popupBlocked()) setProposal(null); // Give approval/settings dialogs priority.
    }, 500);
    return () => { window.clearInterval(timer); previous?.isConnected && previous.focus(); };
  }, [proposal]);
  const respond = async (action: 'skip' | 'today', navigate = false) => {
    if (!proposal || busy) return;
    setBusy(true); setError(false);
    try {
      await respondSecretariat(proposal.id, action);
      if (navigate && proposal.sessionId) window.dispatchEvent(new CustomEvent('kanban-select-session', { detail: { sessionId: proposal.sessionId } }));
      setProposal(null);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  if (!proposal) return null;
  return createPortal(
    <div data-secretariat-overlay className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[3px]">
      <div ref={dialog} data-secretariat-popup role="dialog" aria-modal="true" aria-labelledby="secretariat-popup-title" aria-describedby="secretariat-popup-body" tabIndex={-1}
        className="w-full max-w-xl max-h-[85dvh] flex flex-col overflow-hidden rounded-2xl border border-surface-700/50 bg-surface-900 shadow-2xl outline-none"
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) setProposal(null);
          if (event.key === 'Tab') {
            const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            if (!buttons?.length) return;
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <header className="flex items-center justify-between gap-4 px-6 pt-5 sm:px-8 sm:pt-6">
          <div className="flex items-center gap-2.5 text-sm font-medium text-surface-300">
            <SecretariatFace className="h-14 w-14" />
            <span>비서실</span><span aria-hidden="true" className="text-surface-600">/</span>
            <span className="font-normal text-surface-400">다음 작업 제안</span>
          </div>
          <button aria-label="제안 닫기" disabled={busy} onClick={() => setProposal(null)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:opacity-50">
            <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto px-6 pb-7 pt-6 sm:px-8 sm:pb-8">
          <h2 id="secretariat-popup-title" className="break-words text-2xl font-semibold leading-snug tracking-tight text-surface-100 sm:text-3xl">{proposal.title}</h2>
          <p id="secretariat-popup-body" className="mt-4 whitespace-pre-wrap break-words text-base leading-relaxed text-surface-300 sm:text-lg">{expanded || proposal.body.length <= 600 ? proposal.body : proposal.body.slice(0, Math.min(500, proposal.body.indexOf('\n\n') > 0 ? proposal.body.indexOf('\n\n') : 500)) + '…'}</p>
          {proposal.body.length > 600 && <button className="mt-3 min-h-11 text-sm font-medium text-primary-500 underline underline-offset-4" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? '상세 접기' : '제안 자세히 보기'}</button>}
          <div className="mt-8 flex flex-col gap-2.5 sm:flex-row">
            <button disabled={busy || !proposal.sessionId} onClick={() => void respond('skip', true)}
              className="inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:opacity-50">
              이어서 대화하기
              <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
            </button>
            <button disabled={busy} onClick={() => void respond('skip')}
              className="min-h-12 rounded-xl px-5 py-3 text-sm font-medium text-surface-300 transition-colors hover:bg-surface-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:opacity-50">이번 제안 넘기기</button>
          </div>
          {error && <p role="alert" className="mt-4 text-sm text-red-400">처리하지 못했습니다. 다시 시도해 주세요.</p>}
        </div>
        <footer className="shrink-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-surface-700/50 px-6 py-3 sm:px-8">
          <p className="text-xs leading-relaxed text-surface-400">닫아도 제안함에서 다시 볼 수 있어요.</p>
          <button disabled={busy} onClick={() => void respond('today')}
            className="min-h-11 rounded-lg px-2 text-xs font-medium text-surface-400 underline-offset-4 hover:text-surface-200 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 disabled:opacity-50">24시간 쉬기</button>
        </footer>
      </div>
    </div>, document.body);
}
