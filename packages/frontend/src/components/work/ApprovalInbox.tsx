import React from 'react';
import { notifyApprovalCardsChanged } from '../../stores/approval-store';

type ApprovalStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'cancelled' | 'stale';
type ApprovalBox = 'assigned' | 'sent';
type ApprovalResolution = 'approved' | 'changes_requested' | 'rejected';

interface ApprovalCardSummary {
  id: string;
  projectId: string;
  submitterType?: 'user' | 'workspace_agent';
  submitterUserId: number;
  approverUserId: number;
  sourceSessionId?: string | null;
  requestType: string;
  title: string;
  status: ApprovalStatus;
  currentRevisionNo: number;
  updatedAt: string;
}
interface ApprovalAttachment {
  id: string;
  type: 'markdown' | 'file' | 'link' | 'session' | 'run';
  label?: string | null;
  payload: Record<string, unknown>;
  contentHash?: string | null;
}
interface ApprovalCardDetail extends ApprovalCardSummary {
  revision?: {
    summaryMd: string;
    recommendationMd?: string | null;
    consequenceMd: string;
    options?: Array<{ id: string; label: string }>;
  } | null;
  attachments?: ApprovalAttachment[];
  events?: Array<{ id: string; type: string; actorUserId?: number | null; payload?: Record<string, unknown>; createdAt: string }>;
}

const STATUS_COPY: Record<ApprovalStatus, { label: string; tone: string }> = {
  pending: { label: '승인 대기', tone: 'tone-warning' },
  approved: { label: '승인됨', tone: 'tone-success' },
  changes_requested: { label: '수정 요청', tone: 'tone-info' },
  rejected: { label: '반려됨', tone: 'tone-danger' },
  cancelled: { label: '취소됨', tone: 'tone-muted' },
  stale: { label: '재제출 필요', tone: 'tone-warning' },
};
const RESOLUTION_COPY: Record<ApprovalResolution, { label: string; pending: string }> = {
  approved: { label: '승인', pending: '승인하는 중…' },
  changes_requested: { label: '수정 요청', pending: '요청하는 중…' },
  rejected: { label: '반려', pending: '반려하는 중…' },
};

function authHeaders(json = false): HeadersInit {
  const token = localStorage.getItem('token');
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) };
}
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof DOMException && value.name === 'AbortError') return '요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.';
  if (value instanceof TypeError && /failed to fetch/i.test(value.message)) return '승인함 연결이 잠시 끊겼습니다. 자동으로 다시 시도했지만 불러오지 못했습니다.';
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

async function approvalFetch(input: RequestInfo | URL, init: RequestInit = {}, retries = 1): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted || attempt >= retries) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
    } finally {
      window.clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    }
  }
  throw lastError;
}
function payloadString(attachment: ApprovalAttachment, key: string): string | null {
  const value = attachment.payload?.[key];
  return typeof value === 'string' && value ? value : null;
}
function attachmentLabel(attachment: ApprovalAttachment): string {
  if (attachment.label) return attachment.label;
  return ({ markdown: '메모', file: '파일', link: '링크', session: 'Session', run: 'Run' } as const)[attachment.type];
}
function attachmentIsActionable(attachment: ApprovalAttachment): boolean {
  return (attachment.type === 'file' && !!payloadString(attachment, 'path'))
    || (attachment.type === 'session' && !!payloadString(attachment, 'sessionId'))
    || (attachment.type === 'link' && !!payloadString(attachment, 'url'));
}

function StatusPill({ status }: { status: ApprovalStatus }) {
  const copy = STATUS_COPY[status];
  return <span className={`tone-pill shrink-0 px-2 py-0.5 text-[11px] ${copy.tone}`}>{copy.label}</span>;
}

export function ApprovalInbox({ initialCards }: { initialCards?: ApprovalCardSummary[] } = {}) {
  const [box, setBox] = React.useState<ApprovalBox>('assigned');
  const [cards, setCards] = React.useState<ApprovalCardSummary[]>(initialCards || []);
  const [selectedId, setSelectedId] = React.useState<string | null>(initialCards?.[0]?.id || null);
  React.useEffect(() => {
    const selectApproval = (event: Event) => {
      const approvalId = (event as CustomEvent<{ approvalId?: string }>).detail?.approvalId;
      if (approvalId) setSelectedId(approvalId);
    };
    window.addEventListener('tower-open-approval', selectApproval);
    return () => window.removeEventListener('tower-open-approval', selectApproval);
  }, []);
  const [detail, setDetail] = React.useState<ApprovalCardDetail | null>(null);
  const [listLoading, setListLoading] = React.useState(false);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [resolving, setResolving] = React.useState<ApprovalResolution | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState('');

  const load = React.useCallback(async () => {
    setListLoading(true);
    setError(null);
    try {
      const res = await approvalFetch(`/api/approval-cards?box=${box}&limit=100`, { headers: authHeaders() });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const nextCards: ApprovalCardSummary[] = Array.isArray(data.cards) ? data.cards : [];
      setCards(nextCards);
      setSelectedId((current) => current && nextCards.some((card) => card.id === current) ? current : nextCards[0]?.id || null);
    } catch (err: unknown) {
      setError(errorMessage(err, '승인 요청을 불러오지 못했습니다.'));
    } finally {
      setListLoading(false);
    }
  }, [box]);

  React.useEffect(() => {
    if (initialCards === undefined) void load();
  }, [initialCards, load]);

  React.useEffect(() => {
    setComment('');
    if (!selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    setDetailLoading(true);
    setError(null);
    void approvalFetch(`/api/approval-cards/${selectedId}`, { headers: authHeaders(), signal: controller.signal })
      .then(async (res) => { if (!res.ok) throw new Error(await res.text()); return await res.json(); })
      .then((data) => { if (!controller.signal.aborted) setDetail(data); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(errorMessage(err, '승인 요청 상세를 불러오지 못했습니다.')); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId]);

  React.useEffect(() => {
    if (initialCards !== undefined) return;
    const refresh = () => void load();
    window.addEventListener('tower-approval-cards-changed', refresh);
    return () => window.removeEventListener('tower-approval-cards-changed', refresh);
  }, [initialCards, load]);

  const resolve = async (resolution: ApprovalResolution) => {
    if (!detail || resolving) return;
    setResolving(resolution);
    setError(null);
    try {
      const res = await approvalFetch(`/api/approval-cards/${detail.id}/resolve`, {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({ resolution, commentMd: comment }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '처리에 실패했습니다.');
      setDetail(data);
      setComment('');
      notifyApprovalCardsChanged();
      await load();
    } catch (err: unknown) {
      setError(errorMessage(err, '처리에 실패했습니다.'));
    } finally {
      setResolving(null);
    }
  };

  const openAttachment = (attachment: ApprovalAttachment) => {
    const path = payloadString(attachment, 'path');
    const sessionId = payloadString(attachment, 'sessionId');
    const url = payloadString(attachment, 'url');
    if (attachment.type === 'file' && path) window.dispatchEvent(new CustomEvent('tower-open-path', { detail: { path, split: 'right' } }));
    else if (attachment.type === 'session' && sessionId) window.dispatchEvent(new CustomEvent('kanban-select-session', { detail: { sessionId } }));
    else if (attachment.type === 'link' && url) window.open(url, '_blank', 'noopener,noreferrer');
  };
  const openAIServiceHome = () => {
    window.dispatchEvent(new CustomEvent('tower-open-ai-services', { detail: { source: 'approval-card', approvalId: detail?.id } }));
  };

  return (
    <section aria-labelledby="approval-inbox-title" className="mb-5 overflow-hidden rounded-xl border border-surface-800 bg-surface-900/55" style={{ wordBreak: 'keep-all', overflowWrap: 'break-word' }}>
      <div className="flex flex-col gap-3 border-b border-surface-800 bg-surface-950/45 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-300/80">Approval Cards</div>
          <h2 id="approval-inbox-title" className="mt-0.5 text-[17px] font-semibold text-surface-100">결과 제출·승인함</h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-5 text-surface-500">AI 팀원이나 사람이 공식 제출한 결과를 검토합니다. 일반 질문은 이곳에 들어오지 않습니다.</p>
        </div>
        <div role="tablist" aria-label="승인 요청함" className="grid grid-cols-2 rounded-lg border border-surface-700 bg-surface-900 p-1">
          {(['assigned', 'sent'] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={box === value}
              onClick={() => setBox(value)}
              className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 ${box === value ? 'bg-primary-600 text-white' : 'text-surface-500 hover:bg-surface-800 hover:text-surface-200'}`}
            >
              {value === 'assigned' ? '내 승인 필요' : '보낸 요청'}
            </button>
          ))}
        </div>
      </div>

      {error && <div role="alert" className="flex items-start justify-between gap-3 border-b border-red-400/20 bg-red-500/10 px-4 py-2.5 text-[12px] text-red-200"><span>{error}</span><button onClick={() => { setError(null); void load(); }} className="shrink-0 font-semibold underline underline-offset-2">다시 시도</button></div>}

      <div className="grid min-h-[300px] lg:grid-cols-[minmax(260px,0.78fr)_minmax(0,1.35fr)]">
        <div aria-label={box === 'assigned' ? '내 승인 요청 목록' : '보낸 승인 요청 목록'} className="max-h-[360px] overflow-y-auto border-b border-surface-800 lg:max-h-[560px] lg:border-b-0 lg:border-r">
          {listLoading && cards.length === 0 ? (
            <div aria-live="polite" className="space-y-2 p-4">{[0, 1, 2].map((key) => <div key={key} className="h-14 animate-pulse rounded-lg bg-surface-800/70" />)}</div>
          ) : cards.length === 0 ? (
            <div className="grid min-h-40 place-items-center p-6 text-center"><div><div className="text-[13px] font-medium text-surface-300">{box === 'assigned' ? '처리할 승인 요청이 없습니다.' : '보낸 승인 요청이 없습니다.'}</div><p className="mt-1 text-[12px] leading-5 text-surface-600">새 결과가 제출되면 이 목록에 표시됩니다.</p></div></div>
          ) : cards.map((card) => (
            <button
              key={card.id}
              onClick={() => setSelectedId(card.id)}
              aria-current={selectedId === card.id ? 'true' : undefined}
              className={`block w-full border-b border-surface-800 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/60 ${selectedId === card.id ? 'bg-primary-500/10' : 'hover:bg-surface-800/35'}`}
            >
              <div className="flex items-start justify-between gap-3"><span className="line-clamp-2 text-[13px] font-semibold leading-5 text-surface-100">{card.title}</span><StatusPill status={card.status} /></div>
              <div className="mt-1.5 text-[11px] text-surface-600">{card.submitterType === 'workspace_agent' ? 'AI 팀원 제출' : '사람이 보낸 요청'} · rev {card.currentRevisionNo} · {formatTime(card.updatedAt)}</div>
            </button>
          ))}
        </div>

        <div className="min-w-0 p-4 sm:p-5">
          {detailLoading ? (
            <div aria-live="polite" className="space-y-3"><div className="h-6 w-2/3 animate-pulse rounded bg-surface-800" /><div className="h-32 animate-pulse rounded-lg bg-surface-800/70" /></div>
          ) : !detail ? (
            <div className="grid min-h-48 place-items-center text-center text-[13px] text-surface-500">승인 요청을 선택하면 검토 내용이 표시됩니다.</div>
          ) : (
            <div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="text-[11px] text-surface-600">rev {detail.currentRevisionNo} · {formatTime(detail.updatedAt)}</div><h3 className="mt-1 text-wrap-balance text-[18px] font-semibold leading-7 text-surface-100">{detail.title}</h3></div><StatusPill status={detail.status} /></div>

              <div className="mt-4 border-y border-surface-800 py-4"><div className="whitespace-pre-wrap text-[13px] leading-6 text-surface-200">{detail.revision?.summaryMd}</div>{detail.revision?.recommendationMd && <div className="mt-4 border-t border-surface-800 pt-3"><div className="text-[11px] font-semibold text-primary-300">추천</div><div className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-surface-300">{detail.revision.recommendationMd}</div></div>}<div className="mt-4 border-t border-surface-800 pt-3"><div className="text-[11px] font-semibold text-amber-300">승인하면</div><div className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-surface-300">{detail.revision?.consequenceMd}</div></div></div>

              {(detail.attachments || []).length > 0 && <div className="mt-4"><div className="mb-2 text-[11px] font-semibold text-surface-500">검토 자료 · Viewer에서 근거 확인</div><div className="flex flex-wrap gap-2">{detail.attachments!.map((attachment) => attachmentIsActionable(attachment) ? <button key={attachment.id} onClick={() => openAttachment(attachment)} className="tone-action tone-muted rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:tone-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60">{attachmentLabel(attachment)}</button> : <span key={attachment.id} className="tone-pill tone-muted px-2.5 py-1 text-[11px]">{attachmentLabel(attachment)} · 카드 본문</span>)}</div></div>}

              {detail.status === 'approved' && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/8 p-3"><div><div className="text-[12px] font-semibold text-emerald-200">검토가 완료된 결과입니다</div><p className="mt-1 text-[11px] leading-5 text-surface-500">승인은 배포 실행과 별개입니다. AI 서비스에서 배포 버전과 채널을 다시 확인합니다.</p></div><button type="button" onClick={openAIServiceHome} className="rounded-md border border-primary-400/30 bg-primary-500/10 px-3 py-2 text-[12px] font-semibold text-primary-300 hover:bg-primary-500/15">AI 서비스로 이동</button></div>}

              {box === 'assigned' && detail.status === 'pending' && <div className="mt-5 rounded-lg border border-surface-800 bg-surface-950/40 p-3"><label htmlFor={`approval-comment-${detail.id}`} className="text-[12px] font-medium text-surface-300">검토 의견 <span className="font-normal text-surface-600">수정 요청·반려 시 권장</span></label><textarea id={`approval-comment-${detail.id}`} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="판단 근거나 수정할 내용을 남겨주세요." className="mt-2 min-h-20 w-full resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-[12px] leading-5 text-surface-200 outline-none placeholder:text-surface-650 focus:border-primary-500/60 focus:ring-2 focus:ring-primary-500/15"/><div className="mt-3 flex flex-wrap gap-2"><button disabled={!!resolving} onClick={() => void resolve('approved')} className="tone-action tone-success rounded-md border px-3 py-2 text-[12px] font-semibold transition-opacity disabled:cursor-wait disabled:opacity-60">{resolving === 'approved' ? RESOLUTION_COPY.approved.pending : RESOLUTION_COPY.approved.label}</button><button disabled={!!resolving} onClick={() => void resolve('changes_requested')} className="tone-action tone-warning rounded-md border px-3 py-2 text-[12px] font-semibold transition-opacity disabled:cursor-wait disabled:opacity-60">{resolving === 'changes_requested' ? RESOLUTION_COPY.changes_requested.pending : RESOLUTION_COPY.changes_requested.label}</button><button disabled={!!resolving} onClick={() => void resolve('rejected')} className="tone-action tone-danger rounded-md border px-3 py-2 text-[12px] font-semibold transition-opacity disabled:cursor-wait disabled:opacity-60">{resolving === 'rejected' ? RESOLUTION_COPY.rejected.pending : RESOLUTION_COPY.rejected.label}</button>{detail.sourceSessionId && <button disabled={!!resolving} onClick={() => window.dispatchEvent(new CustomEvent('kanban-select-session', { detail: { sessionId: detail.sourceSessionId } }))} className="rounded-md border border-surface-700 px-3 py-2 text-[12px] font-medium text-surface-300 transition-colors hover:border-primary-500/40 hover:text-primary-200 disabled:opacity-60">Session에서 검토</button>}</div></div>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
