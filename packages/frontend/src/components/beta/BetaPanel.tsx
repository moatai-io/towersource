import React from 'react';
import { useProjectStore } from '../../stores/project-store';
import { useSettingsStore } from '../../stores/settings-store';
import { AgentHiringWizard } from './AgentHiringWizard';

interface ScoreRubricItem { id: string; label: string; score: number; note: string }
interface WorkbenchRun {
  id: 'skill-off' | 'draft' | 'baseline';
  label: string;
  skillName?: string;
  output: string;
  elapsedMs: number;
  score: { total: number; rubric: ScoreRubricItem[] };
  error?: string;
}
interface WorkbenchResult {
  id: string;
  createdAt: string;
  projectId?: string | null;
  prompt: string;
  draftSkillName?: string | null;
  baselineSkillName?: string | null;
  winnerId?: WorkbenchRun['id'] | null;
  runs: WorkbenchRun[];
  testCaseId?: string | null;
}
interface TestCase {
  id: string;
  title: string;
  prompt: string;
  projectId?: string | null;
  draftSkillName?: string | null;
  baselineSkillName?: string | null;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

type SideTab = 'history' | 'cases';
type BetaMode = 'agent-builder' | 'skill-workbench';
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function apiJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts?.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data as T;
}

function ScoreBadge({ score, winner }: { score?: number; winner?: boolean }) {
  const value = Number.isFinite(score) ? score! : 0;
  const tone = value >= 70 ? 'text-emerald-200 bg-emerald-500/15 border-emerald-500/30'
    : value >= 40 ? 'text-amber-200 bg-amber-500/15 border-amber-500/30'
    : 'text-red-200 bg-red-500/15 border-red-500/30';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold ${winner ? 'ring-1 ring-primary-400/60 ' : ''}${tone}`}>
      {winner ? '★ ' : ''}{value}/100
    </span>
  );
}

function RunColumn({ run, winner }: { run: WorkbenchRun; winner: boolean }) {
  return (
    <section className={`min-w-0 rounded-xl border p-4 flex flex-col gap-3 ${winner ? 'border-primary-500/60 bg-primary-500/5' : 'border-surface-700/70 bg-surface-900/70'}`}>
      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-100">{run.label}</h3>
          <div className="flex items-center gap-2">
            <ScoreBadge score={run.score?.total} winner={winner} />
            <span className="text-[11px] text-surface-500">{run.elapsedMs}ms</span>
          </div>
        </div>
        {run.skillName && <p className="mt-1 text-xs text-primary-300 truncate">/{run.skillName}</p>}
      </div>
      {run.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {run.error}
        </div>
      )}
      {run.score?.rubric?.length > 0 && (
        <div className="grid grid-cols-2 gap-1 text-[11px] text-surface-400">
          {run.score.rubric.filter((r) => r.id !== 'error' && r.id !== 'empty').map((item) => (
            <div key={item.id} className="rounded bg-surface-950/70 px-2 py-1">
              <span className="text-surface-500">{item.label}</span> <span className="text-gray-200 font-semibold">{item.score}</span>
            </div>
          ))}
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-200 font-sans overflow-auto min-h-[320px] max-h-[55vh]">
        {run.output || '—'}
      </pre>
    </section>
  );
}

export function BetaPanel() {
  const betaWorkbenchEnabled = useSettingsStore((s) => !!s.serverConfig?.betaWorkbenchEnabled);
  const projects = useProjectStore((s) => s.projects);
  const pinnedProject = projects.find((p) => p.pinned) ?? projects[0];
  const [projectId, setProjectId] = React.useState<string>(pinnedProject?.id ?? '');
  const [prompt, setPrompt] = React.useState('');
  const [draftSkillName, setDraftSkillName] = React.useState('great-copy');
  const [baselineSkillName, setBaselineSkillName] = React.useState('marketing-coach');
  const [result, setResult] = React.useState<WorkbenchResult | null>(null);
  const [history, setHistory] = React.useState<WorkbenchResult[]>([]);
  const [testCases, setTestCases] = React.useState<TestCase[]>([]);
  const [activeSideTab, setActiveSideTab] = React.useState<SideTab>('history');
  const [title, setTitle] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [selectedTestCaseId, setSelectedTestCaseId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [activeBetaMode, setActiveBetaMode] = React.useState<BetaMode>('agent-builder');
  const refreshSideData = React.useCallback(async () => {
    if (!betaWorkbenchEnabled) return;
    try {
      const [h, c] = await Promise.all([
        apiJson<{ history: WorkbenchResult[] }>('/api/beta/skill-workbench/history?limit=30'),
        apiJson<{ testCases: TestCase[] }>('/api/beta/skill-workbench/test-cases'),
      ]);
      setHistory(h.history || []);
      setTestCases(c.testCases || []);
    } catch (err: any) {
      setError(err?.message || 'Beta 데이터를 불러오지 못했습니다.');
    }
  }, [betaWorkbenchEnabled]);

  React.useEffect(() => {
    if (!projectId && pinnedProject?.id) setProjectId(pinnedProject.id);
  }, [pinnedProject?.id, projectId]);

  React.useEffect(() => { void refreshSideData(); }, [refreshSideData]);

  React.useEffect(() => {
    const onMode = (event: Event) => {
      const mode = (event as CustomEvent<{ mode?: BetaMode }>).detail?.mode;
      if (mode === 'agent-builder' || mode === 'skill-workbench') setActiveBetaMode(mode);
    };
    window.addEventListener('tower-beta-mode', onMode as EventListener);
    return () => window.removeEventListener('tower-beta-mode', onMode as EventListener);
  }, []);

  if (!betaWorkbenchEnabled) {
    return <div className="flex-1 flex items-center justify-center text-sm text-surface-500">Beta workbench is not enabled on this VM.</div>;
  }

  const loadCase = (item: TestCase) => {
    setSelectedTestCaseId(item.id);
    setTitle(item.title);
    setNotes(item.notes || '');
    setPrompt(item.prompt);
    setProjectId(item.projectId || '');
    setDraftSkillName(item.draftSkillName || '');
    setBaselineSkillName(item.baselineSkillName || '');
    setActiveSideTab('cases');
  };

  const loadHistory = (item: WorkbenchResult) => {
    setResult(item);
    setPrompt(item.prompt);
    setProjectId(item.projectId || '');
    setDraftSkillName(item.draftSkillName || '');
    setBaselineSkillName(item.baselineSkillName || '');
  };

  const runWorkbench = async () => {
    if (!prompt.trim()) { setError('비교할 prompt를 입력하세요.'); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const data = await apiJson<WorkbenchResult>('/api/beta/skill-workbench/run', {
        method: 'POST',
        body: JSON.stringify({
          projectId: projectId || undefined,
          prompt,
          draftSkillName: draftSkillName.trim() || undefined,
          baselineSkillName: baselineSkillName.trim() || undefined,
          testCaseId: selectedTestCaseId || undefined,
        }),
      });
      setResult(data);
      await refreshSideData();
    } catch (err: any) {
      setError(err?.message || 'Skill workbench 실행에 실패했습니다.');
    } finally { setBusy(false); }
  };

  const saveCase = async () => {
    if (!prompt.trim()) { setError('저장할 prompt를 입력하세요.'); return; }
    setSaving(true); setError(null);
    try {
      const data = await apiJson<{ testCase: TestCase }>('/api/beta/skill-workbench/test-cases', {
        method: 'POST',
        body: JSON.stringify({
          id: selectedTestCaseId || undefined,
          title: title.trim() || undefined,
          prompt,
          projectId: projectId || undefined,
          draftSkillName: draftSkillName.trim() || undefined,
          baselineSkillName: baselineSkillName.trim() || undefined,
          notes,
        }),
      });
      setSelectedTestCaseId(data.testCase.id);
      setTitle(data.testCase.title);
      await refreshSideData();
      setActiveSideTab('cases');
    } catch (err: any) {
      setError(err?.message || 'Test case 저장에 실패했습니다.');
    } finally { setSaving(false); }
  };

  const deleteCase = async (item: TestCase) => {
    setError(null);
    try {
      await apiJson<{ deleted: boolean }>(`/api/beta/skill-workbench/test-cases/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (selectedTestCaseId === item.id) {
        setSelectedTestCaseId(null);
        setTitle('');
        setNotes('');
      }
      await refreshSideData();
    } catch (err: any) {
      setError(err?.message || 'Test case 삭제에 실패했습니다.');
    }
  };

  if (activeBetaMode === 'agent-builder') {
    return (
      <div className="flex-1 min-h-0 overflow-auto bg-surface-950 text-gray-100">
        <div className="max-w-[1600px] mx-auto p-6">
          <AgentHiringWizard projects={projects} projectId={projectId} setProjectId={setProjectId} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-surface-950 text-gray-100">
      <div className="max-w-[1600px] mx-auto p-6 space-y-6">
        <header className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1 text-xs font-semibold text-primary-300">Beta 기능 · full VM only</div>
            <h1 className="text-2xl font-bold tracking-tight">Skill Workbench</h1>
            <p className="max-w-3xl text-sm leading-6 text-surface-400">Skill off · Draft · Baseline 결과를 비교하고 scoring/history/test case를 저장합니다.</p>
          </div>
          {result?.winnerId && <div className="rounded-xl border border-primary-500/30 bg-primary-500/10 px-4 py-3 text-sm text-primary-300">현재 자동 추천: <b>{result.runs.find((r) => r.id === result.winnerId)?.label}</b></div>}
        </header>

        <div className="grid grid-cols-1 2xl:grid-cols-[1fr_360px] gap-5">
          <div className="space-y-5 min-w-0">
            <section className="rounded-2xl border border-surface-700/70 bg-surface-900/80 p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <label className="text-xs font-semibold text-surface-400 space-y-1 md:col-span-1">Project context
                  <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full rounded-lg bg-surface-950 border border-surface-700 px-3 py-2 text-sm text-gray-100 outline-none focus:border-primary-500">
                    <option value="">No project</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </label>
                <label className="text-xs font-semibold text-surface-400 space-y-1">Draft skill
                  <input value={draftSkillName} onChange={(e) => setDraftSkillName(e.target.value)} placeholder="great-copy" className="w-full rounded-lg bg-surface-950 border border-surface-700 px-3 py-2 text-sm text-gray-100 outline-none focus:border-primary-500" />
                </label>
                <label className="text-xs font-semibold text-surface-400 space-y-1">Baseline skill
                  <input value={baselineSkillName} onChange={(e) => setBaselineSkillName(e.target.value)} placeholder="marketing-coach" className="w-full rounded-lg bg-surface-950 border border-surface-700 px-3 py-2 text-sm text-gray-100 outline-none focus:border-primary-500" />
                </label>
                <label className="text-xs font-semibold text-surface-400 space-y-1">Case title
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional test case title" className="w-full rounded-lg bg-surface-950 border border-surface-700 px-3 py-2 text-sm text-gray-100 outline-none focus:border-primary-500" />
                </label>
              </div>

              <label className="block text-xs font-semibold text-surface-400 space-y-1">Prompt
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="비교할 사용자 입력을 붙여 넣으세요." rows={8} className="w-full resize-y rounded-xl bg-surface-950 border border-surface-700 px-3 py-3 text-sm text-gray-100 outline-none focus:border-primary-500" />
              </label>
              <label className="block text-xs font-semibold text-surface-400 space-y-1">Notes
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="이 케이스에서 보고 싶은 점, 성공 기준 등" className="w-full rounded-lg bg-surface-950 border border-surface-700 px-3 py-2 text-sm text-gray-100 outline-none focus:border-primary-500" />
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button onClick={runWorkbench} disabled={busy} className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-400 disabled:opacity-50 disabled:cursor-not-allowed">{busy ? 'Running…' : 'Run comparison'}</button>
                <button onClick={saveCase} disabled={saving} className="rounded-lg border border-surface-700 bg-surface-850 px-4 py-2 text-sm font-semibold text-surface-200 hover:bg-surface-800 disabled:opacity-50">{saving ? 'Saving…' : selectedTestCaseId ? 'Update test case' : 'Save as test case'}</button>
                {selectedTestCaseId && <button onClick={() => { setSelectedTestCaseId(null); setTitle(''); setNotes(''); }} className="text-sm text-surface-400 hover:text-gray-100">새 케이스로 전환</button>}
                {error && <p className="text-sm text-red-300">{error}</p>}
              </div>
            </section>

            {result && (
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                {result.runs.map((run) => <RunColumn key={run.id} run={run} winner={result.winnerId === run.id} />)}
              </div>
            )}
          </div>

          <aside className="rounded-2xl border border-surface-700/70 bg-surface-900/80 p-3 h-fit max-h-[calc(100vh-120px)] overflow-auto">
            <div className="grid grid-cols-2 rounded-lg bg-surface-950 p-1 text-xs font-semibold">
              <button onClick={() => setActiveSideTab('history')} className={`rounded-md px-2 py-1.5 ${activeSideTab === 'history' ? 'bg-surface-800 text-primary-300' : 'text-surface-500'}`}>History</button>
              <button onClick={() => setActiveSideTab('cases')} className={`rounded-md px-2 py-1.5 ${activeSideTab === 'cases' ? 'bg-surface-800 text-primary-300' : 'text-surface-500'}`}>Test cases</button>
            </div>
            <div className="mt-3 space-y-2">
              {activeSideTab === 'history' ? (
                history.length ? history.map((item) => (
                  <button key={item.id} onClick={() => loadHistory(item)} className="w-full rounded-lg border border-surface-800 bg-surface-950/70 p-3 text-left hover:border-surface-600">
                    <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-gray-200">{item.prompt.slice(0, 70)}</span><span className="text-[11px] text-surface-500">{new Date(item.createdAt).toLocaleString()}</span></div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-surface-400"><ScoreBadge score={item.runs.find((r) => r.id === item.winnerId)?.score.total} winner /> <span>{item.runs.find((r) => r.id === item.winnerId)?.label || 'No winner'}</span></div>
                  </button>
                )) : <p className="p-3 text-sm text-surface-500">아직 history가 없습니다.</p>
              ) : (
                testCases.length ? testCases.map((item) => (
                  <div key={item.id} className={`rounded-lg border p-3 hover:border-surface-600 ${selectedTestCaseId === item.id ? 'border-primary-500/60 bg-primary-500/5' : 'border-surface-800 bg-surface-950/70'}`}>
                    <button onClick={() => loadCase(item)} className="w-full text-left">
                      <div className="text-sm font-semibold text-gray-200 truncate">{item.title}</div>
                      <div className="mt-1 text-xs text-surface-500 line-clamp-2">{item.prompt}</div>
                      <div className="mt-2 text-[11px] text-surface-500">/{item.draftSkillName || 'draft'} vs /{item.baselineSkillName || 'baseline'}</div>
                    </button>
                    <div className="mt-2 flex justify-end">
                      <button onClick={() => deleteCase(item)} className="text-[11px] text-surface-500 hover:text-red-300">삭제</button>
                    </div>
                  </div>
                )) : <p className="p-3 text-sm text-surface-500">저장된 test case가 없습니다.</p>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default BetaPanel;
