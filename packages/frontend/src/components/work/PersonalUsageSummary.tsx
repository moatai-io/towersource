import i18n from '../../i18n';
import React from 'react';

interface PersonalUsageProject {
  id: string;
  name: string;
  total: number;
  values: number[];
}

interface PersonalUsageResponse {
  days: number;
  dates: string[];
  totals: {
    sessions: number;
    turns: number;
    totalTokens: number;
    costUsd: number;
  };
  projects: PersonalUsageProject[];
  costBasis: 'message-provider-metadata' | 'session-estimate';
  costAvailable: boolean;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString(i18n.resolvedLanguage || i18n.language);
}

function formatCost(value: number): string {
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function intensityClass(value: number, max: number): string {
  if (value <= 0) return 'scale-[0.42] border-surface-800/60 bg-surface-800/35 opacity-45';
  const ratio = value / Math.max(max, 1);
  if (ratio <= 0.12) return 'scale-[0.56] border-cyan-300/15 bg-cyan-200/20';
  if (ratio <= 0.3) return 'scale-[0.7] border-cyan-300/25 bg-cyan-300/35';
  if (ratio <= 0.55) return 'scale-[0.82] border-cyan-300/45 bg-cyan-400/55';
  if (ratio <= 0.8) return 'scale-[0.94] border-cyan-200/70 bg-cyan-400/80 shadow-[0_0_7px_rgba(34,211,238,0.24)]';
  return 'scale-100 border-cyan-100 bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.62)] ring-1 ring-cyan-200/60';
}

const HEATMAP_LEGEND_LEVELS = [0, 0.08, 0.22, 0.42, 0.68, 1];

/** Authenticated user's own AI usage; never shows VM-wide budget or another user's rows. */
export function PersonalUsageSummary() {
  const [days, setDays] = React.useState(30);
  const [data, setData] = React.useState<PersonalUsageResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/metrics/my-ai-usage?days=${days}`, { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || '개인 사용량을 불러오지 못했습니다.');
      setData(json as PersonalUsageResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '개인 사용량을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [days]);

  React.useEffect(() => { void load(); }, [load]);

  return (
    <section aria-labelledby="personal-usage-title" className="mb-5 overflow-hidden rounded-xl border border-surface-800 bg-surface-900/45">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-surface-800 px-4 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300/80">My usage</div>
          <h2 id="personal-usage-title" className="mt-0.5 text-[17px] font-semibold text-surface-100">내 AI 사용량</h2>
          <p className="mt-1 text-[12px] leading-5 text-surface-500">내가 만든 세션의 사용량과 공급자가 기록한 추정 비용입니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(event) => setDays(Number(event.target.value))} className="h-8 rounded-md border border-surface-700 bg-surface-950 px-2 text-[12px] text-surface-300">
            <option value={7}>최근 7일</option>
            <option value={30}>최근 30일</option>
            <option value={90}>최근 90일</option>
          </select>
          <button type="button" onClick={() => void load()} disabled={loading} className="h-8 rounded-md border border-surface-700 px-2.5 text-[12px] text-surface-300 disabled:opacity-50">{loading ? '…' : '새로고침'}</button>
        </div>
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-3 px-4 py-4 text-[12px] text-amber-200"><span>{error}</span><button type="button" onClick={() => void load()} className="font-semibold">다시 시도</button></div>
      ) : (
        <>
          <div className="grid grid-cols-2 divide-x divide-y divide-surface-800 sm:grid-cols-4 sm:divide-y-0">
            <UsageValue label="세션" value={loading || !data ? '—' : data.totals.sessions.toLocaleString('ko-KR')} />
            <UsageValue label="대화 턴" value={loading || !data ? '—' : data.totals.turns.toLocaleString('ko-KR')} />
            <UsageValue label="토큰" value={loading || !data ? '—' : formatTokens(data.totals.totalTokens)} />
            <UsageValue label="추정 비용" value={loading || !data ? '—' : data.costAvailable ? formatCost(data.totals.costUsd) : '집계 없음'} emphasis={!!data?.costAvailable} />
          </div>
          {data && data.projects.length > 0 && <PersonalUsageHeatmap data={data} />}
        </>
      )}
      <div className="border-t border-surface-800 px-4 py-2 text-[10px] leading-4 text-surface-600">비용이 제공되는 모델 호출만 집계합니다. Claude 구독형 실행처럼 공급자 비용이 없는 호출은 ‘집계 없음’으로 표시될 수 있습니다.</div>
    </section>
  );
}

function PersonalUsageHeatmap({ data }: { data: PersonalUsageResponse }) {
  const max = Math.max(1, ...data.projects.flatMap((project) => project.values));
  const step = data.days <= 14 ? 1 : data.days <= 30 ? 3 : 7;
  return (
    <div className="overflow-x-auto border-t border-surface-800 px-4 py-3">
      <div className="min-w-[520px]">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="text-[11px] font-semibold text-surface-400">프로젝트별 대화 강도</div>
          <div className="flex items-center gap-1.5 text-[10px] text-surface-500" aria-label="대화 강도 범례"><span>적게</span><div className="flex items-center gap-1">{HEATMAP_LEGEND_LEVELS.map((ratio) => <span key={ratio} className={`h-3 w-3 rounded-full border transition-transform ${intensityClass(ratio === 0 ? 0 : Math.max(1, max * ratio), max)}`} />)}</div><span className="font-semibold text-cyan-200">많이</span><span className="ml-1 text-surface-600">최대 {max}턴/일</span></div>
        </div>
        <div className="grid items-center gap-1" style={{ gridTemplateColumns: `140px repeat(${data.dates.length}, minmax(6px, 1fr)) 38px` }}>
          <span />
          {data.dates.map((date, index) => <span key={date} className="h-4 text-center text-[8px] text-surface-700">{index % step === 0 ? date.slice(5) : ''}</span>)}
          <span className="text-right text-[9px] text-surface-600">합계</span>
          {data.projects.map((project) => (
            <React.Fragment key={project.id}>
              <span className="truncate pr-2 text-[10px] text-surface-400" title={project.name}>{project.name}</span>
              {project.values.map((value, index) => <span key={`${project.id}:${data.dates[index]}`} title={`${project.name} · ${data.dates[index]} · ${value}턴`} aria-label={`${project.name} ${data.dates[index]} ${value}턴`} className={`h-3.5 rounded-full border transition duration-150 hover:z-10 hover:scale-125 hover:brightness-125 ${intensityClass(value, max)}`} />)}
              <span className="text-right text-[10px] tabular-nums text-surface-400">{project.total}</span>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

function UsageValue({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.12em] text-surface-600">{label}</div>
      <div className={`mt-1 text-[18px] font-semibold tabular-nums ${emphasis ? 'text-emerald-300' : 'text-surface-100'}`}>{value}</div>
    </div>
  );
}
