import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useState } from 'react';

interface ProposalRange { start: number; end: number; lineStart: number; lineEnd: number; selector?: string; kind: string }
interface ProposalFile { path: string; ranges: ProposalRange[] }
export interface ScopedMultiFileProposal { version: 1; intentId: string; proposalHash: string; expiresAt: string; files: ProposalFile[] }
type ApplyState = 'ready' | 'applying' | 'applied' | 'expired' | 'error';

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('token');
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export function ScopedMultiFileEditCard({ proposal }: { proposal: ScopedMultiFileProposal }) {
  const { t } = useTranslation('chat');
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<ApplyState>(Date.parse(proposal.expiresAt) <= Date.now() ? 'expired' : 'ready');
  const [error, setError] = useState('');
  const rangeCount = useMemo(() => proposal.files.reduce((sum, file) => sum + file.ranges.length, 0), [proposal.files]);

  useEffect(() => {
    if (state === 'applied') return;
    let cancelled = false;
    fetch(`/api/files/scoped-edit/multi-file-proposal/${encodeURIComponent(proposal.intentId)}?proposalHash=${encodeURIComponent(proposal.proposalHash)}`, { headers: authHeaders() })
      .then(async response => ({ response, body: await response.json().catch(() => ({})) }))
      .then(({ response, body }) => {
        if (cancelled) return;
        if (!response.ok) { setState('expired'); return; }
        if (body.status === 'applied') setState('applied');
        else if (body.status === 'applying') setState('applying');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [proposal.intentId, proposal.proposalHash]);

  async function apply() {
    if (!confirmed || state !== 'ready') return;
    setState('applying'); setError('');
    try {
      const response = await fetch('/api/files/scoped-edit/multi-file-apply', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ intentId: proposal.intentId, proposalHash: proposal.proposalHash, confirmed: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'multi_file_apply_failed');
      setState('applied'); setConfirmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'multi_file_apply_failed');
      setState('error'); setConfirmed(false);
    }
  }

  return (
    <section className="tone-accent tone-card mt-3 w-full max-w-2xl rounded-xl p-3 text-left" aria-label={t('scopedEdit.confirmation', { defaultValue: '여러 파일의 선택 영역 수정 확인' })}>
      <h4 className="text-[14px] font-semibold text-surface-100">여러 파일의 제한된 범위 수정</h4>
      <p className="mt-1 text-[13px] leading-5 text-surface-400">{proposal.files.length}개 파일, {rangeCount}개 source 범위입니다. 승인 전에는 파일을 변경하지 않습니다.</p>
      <div className="mt-3 space-y-2">
        {proposal.files.map(file => (
          <div key={file.path} className="rounded-lg border border-surface-700 bg-surface-900/70 px-3 py-2">
            <div className="truncate text-[13px] font-medium text-surface-200" title={file.path}>{file.path}</div>
            <ul className="mt-1 space-y-1 text-[12px] text-surface-500">
              {file.ranges.map((range, index) => <li key={`${range.start}-${range.end}-${index}`}>L{range.lineStart}–L{range.lineEnd}{range.selector ? ` · ${range.selector}` : ''}</li>)}
            </ul>
          </div>
        ))}
      </div>
      {state === 'ready' && <>
        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 border-t border-surface-700 pt-3 text-[13px] leading-5 text-surface-300">
          <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 accent-primary-500" />
          <span>위 파일과 source 범위만 함께 수정하는 것을 승인합니다. 적용 시 모든 파일을 잠그고 원본 hash를 다시 확인합니다.</span>
        </label>
        <button type="button" disabled={!confirmed} onClick={() => void apply()} className="tone-accent tone-action mt-2 min-h-11 w-full rounded-lg px-4 text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-50">승인하고 함께 적용</button>
      </>}
      {state === 'applying' && <p className="mt-3 text-[13px] text-surface-400" role="status">파일을 검증하고 적용하는 중…</p>}
      {state === 'applied' && <p className="tone-success tone-card mt-3 rounded-lg p-2.5 text-[13px]" role="status">승인된 범위를 모든 파일에 적용했습니다.</p>}
      {state === 'expired' && <p className="tone-warning tone-card mt-3 rounded-lg p-2.5 text-[13px]">이 변경 계획은 만료되었거나 이미 사용되었습니다. 요소를 다시 선택해 주세요.</p>}
      {state === 'error' && <p className="tone-danger tone-card mt-3 rounded-lg p-2.5 text-[13px]" role="alert">적용하지 못했습니다: {error || '상태를 확인할 수 없습니다.'}</p>}
      <p className="mt-2 text-[11px] leading-4 text-surface-600">프로세스 내 적용 오류는 원본으로 rollback합니다. 서버나 호스트가 파일 교체 도중 강제 종료되는 경우의 crash recovery는 아직 지원하지 않습니다.</p>
    </section>
  );
}
