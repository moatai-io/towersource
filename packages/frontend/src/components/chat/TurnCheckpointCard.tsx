import { useMemo, useState } from 'react';

type CheckpointChange = { filePath: string; beforeExists: boolean; afterExists: boolean };
type PreviewItem = { filePath: string; action: 'create' | 'update' | 'delete' | 'noop'; status: 'ready' | 'conflict' };
type Checkpoint = { id: string; coverage: 'tool_edits' | 'partial'; changes: CheckpointChange[] };
type Preview = { previewHash: string; items: PreviewItem[]; canApply: boolean; coverage: 'tool_edits' | 'partial' };
type UiState = 'closed' | 'loading' | 'ready' | 'previewing' | 'applying' | 'applied' | 'empty' | 'error';

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('token');
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
function fileName(filePath: string) { return filePath.split('/').filter(Boolean).pop() || filePath; }
function actionLabel(action: PreviewItem['action']) {
  return action === 'delete' ? '생성 파일 삭제' : action === 'create' ? '삭제 파일 복구' : action === 'update' ? '이전 내용 복원' : '변경 없음';
}

export function TurnCheckpointCard({ sessionId, turnId }: { sessionId: string; turnId: string }) {
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<UiState>('closed');
  const [error, setError] = useState('');
  const selectedPaths = useMemo(() => [...selected], [selected]);

  async function requestPreview(next: Checkpoint, paths: string[]) {
    setState('previewing'); setError(''); setConfirmed(false);
    const response = await fetch(`/api/checkpoints/${encodeURIComponent(next.id)}/restore-preview`, {
      method: 'POST', headers: authHeaders(true), body: JSON.stringify({ paths }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '복원 가능성을 확인하지 못했습니다.');
    setPreview(body as Preview); setState('ready');
  }

  async function openCheckpoint() {
    setState('loading'); setError('');
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/checkpoint`, { headers: authHeaders() });
      if (response.status === 404) { setState('empty'); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '파일 변경 기록을 불러오지 못했습니다.');
      const next = body as Checkpoint;
      const paths = next.changes.map((change) => change.filePath);
      setCheckpoint(next); setSelected(new Set(paths));
      await requestPreview(next, paths);
    } catch (err) { setError(err instanceof Error ? err.message : '파일 변경 기록을 불러오지 못했습니다.'); setState('error'); }
  }

  async function refreshPreview(paths = selectedPaths) {
    if (!checkpoint || paths.length === 0) return;
    try { await requestPreview(checkpoint, paths); }
    catch (err) { setError(err instanceof Error ? err.message : '복원 가능성을 다시 확인하지 못했습니다.'); setState('error'); }
  }

  async function applyRestore() {
    if (!checkpoint || !preview || !confirmed || selectedPaths.length === 0) return;
    setState('applying'); setError('');
    try {
      const response = await fetch(`/api/checkpoints/${encodeURIComponent(checkpoint.id)}/restore`, {
        method: 'POST', headers: authHeaders(true),
        body: JSON.stringify({ confirmed: true, previewHash: preview.previewHash, paths: selectedPaths }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '파일을 복원하지 못했습니다.');
      setState('applied'); setConfirmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '파일을 복원하지 못했습니다.');
      setConfirmed(false); setState('error');
    }
  }

  if (state === 'closed') return (
    <button type="button" onClick={() => void openCheckpoint()} className="mt-2 min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] font-medium text-surface-500 transition-colors hover:border-primary-500 hover:text-primary-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" aria-label="이 턴의 파일 변경 확인">
      파일 변경 확인
    </button>
  );
  if (state === 'empty') return <div className="mt-2 text-[13px] text-surface-500">이 턴에는 복원 가능한 파일 변경이 없습니다.</div>;
  if (state === 'loading' || state === 'previewing') return <div className="mt-2 min-h-10 text-[13px] text-surface-500" role="status">{state === 'loading' ? '파일 변경을 불러오는 중…' : '현재 파일 상태를 확인하는 중…'}</div>;

  const hasConflict = !!preview?.items.some((item) => item.status === 'conflict');
  return (
    <section className="tone-muted tone-card mt-2 w-full max-w-xl rounded-xl p-3 text-left" aria-label="턴 파일 복원">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-[14px] font-semibold text-surface-200">이 턴의 파일 변경</h4>
          <p className="mt-1 text-[13px] leading-5 text-surface-500">선택한 파일만 턴 시작 전 내용으로 되돌립니다.</p>
        </div>
        <button type="button" onClick={() => { setState('closed'); setError(''); }} className="min-h-10 rounded-lg px-3 text-[13px] text-surface-500 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">닫기</button>
      </div>

      {checkpoint?.coverage === 'partial' && <div className="tone-warning tone-card mt-3 rounded-lg p-2.5 text-[13px] leading-5"><strong className="tone-text">일부 변경만 기록됨</strong><span className="text-surface-400"> · 터미널에서 만든 변경은 목록에 없을 수 있습니다.</span></div>}
      {error && <div className="tone-danger tone-card mt-3 rounded-lg p-2.5 text-[13px]" role="alert">{error} <button type="button" className="ml-2 underline underline-offset-2" onClick={() => void refreshPreview()}>다시 확인</button></div>}
      {state === 'applied' && <div className="tone-success tone-card mt-3 rounded-lg p-2.5 text-[13px]" role="status">선택한 파일을 턴 시작 전 상태로 복원했습니다.</div>}

      {preview && state !== 'applied' && <div className="mt-3 space-y-2">
        {preview.items.map((item) => {
          const checked = selected.has(item.filePath);
          return <label key={item.filePath} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 focus-within:ring-2 focus-within:ring-primary-500">
            <input type="checkbox" checked={checked} onChange={() => {
              const next = new Set(selected); checked ? next.delete(item.filePath) : next.add(item.filePath); setSelected(next); setPreview(null); setConfirmed(false);
            }} className="h-4 w-4 accent-primary-500" />
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-surface-200" title={item.filePath}>{fileName(item.filePath)}</span><span className="block truncate text-[12px] text-surface-500" title={item.filePath}>{item.filePath}</span></span>
            <span className={`tone-pill text-[12px] ${item.status === 'conflict' ? 'tone-warning' : 'tone-muted'}`}>{item.status === 'conflict' ? '이후 변경 있음' : actionLabel(item.action)}</span>
          </label>;
        })}
      </div>}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {!preview && <button type="button" disabled={selectedPaths.length === 0} onClick={() => void refreshPreview()} className="tone-accent tone-action min-h-10 rounded-lg px-3 text-[13px] font-semibold disabled:cursor-not-allowed disabled:border-surface-700 disabled:bg-surface-900 disabled:text-surface-600">선택 상태 확인</button>}
        {preview && <button type="button" onClick={() => void refreshPreview()} className="min-h-10 rounded-lg border border-surface-700 px-3 text-[13px] text-surface-400 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">다시 확인</button>}
      </div>

      {preview && !hasConflict && state !== 'applied' && <div className="mt-3 border-t border-surface-700 pt-3">
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-[13px] leading-5 text-surface-300"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 accent-primary-500" /><span>선택한 파일의 현재 내용을 턴 시작 전 내용으로 교체하는 것을 확인했습니다.</span></label>
        <button type="button" disabled={!confirmed || state === 'applying'} onClick={() => void applyRestore()} className="tone-danger tone-action mt-2 min-h-11 w-full rounded-lg px-4 text-[14px] font-semibold disabled:cursor-not-allowed disabled:border-surface-700 disabled:bg-surface-900 disabled:text-surface-600">{state === 'applying' ? '복원하는 중…' : `선택한 파일 ${selectedPaths.length}개 복원`}</button>
      </div>}
      {preview && hasConflict && <p className="tone-warning tone-text mt-3 text-[13px] leading-5">이 턴 이후 변경된 파일이 있어 지금은 복원할 수 없습니다. 파일을 확인한 뒤 다시 시도하세요.</p>}
    </section>
  );
}
