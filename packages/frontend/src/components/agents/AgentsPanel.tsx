// Owns: project agent definition browser for `.tower/agents/*.agent.yaml|json`.
// Public API: AgentsPanel.

import React, { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { toastError, toastSuccess } from '../../utils/toast';

interface AgentWorkerSummary {
  id: string;
  name: string;
  status: string;
  visibility: string;
  backing_session_id?: string | null;
  updated_at?: string;
  last_heartbeat_at?: string | null;
}

interface AgentRunSummary {
  id: string;
  status: string;
  result_summary?: string | null;
  artifact_paths?: unknown[] | null;
  error?: string | null;
  started_at?: string;
  ended_at?: string | null;
  updated_at?: string;
}

interface AgentStateCardSummary {
  goal?: string;
  current_focus?: string;
  last_action?: string;
  next_action?: string;
  confidence?: string | null;
  updated_at?: string;
}

interface AgentDefinition {
  id: string;
  displayName?: string;
  role: string;
  instruction: string;
  goal?: string;
  engine?: 'pi' | 'claude';
  model?: string;
  visibility: 'background' | 'sidebar' | 'team' | 'system';
  permissions?: Record<string, unknown>;
  report?: Record<string, unknown>;
  sourcePath: string;
  worker?: AgentWorkerSummary | null;
  latestRun?: AgentRunSummary | null;
  stateCard?: AgentStateCardSummary | null;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function compactJson(value?: Record<string, unknown>): string {
  if (!value) return '—';
  try { return JSON.stringify(value); } catch { return '—'; }
}

function sourceRelative(path: string): string {
  const idx = path.indexOf('/.tower/agents/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

const EMPTY_AGENT: AgentDefinition = {
  id: '',
  displayName: '',
  role: '',
  instruction: '',
  visibility: 'background',
  sourcePath: '',
};

function toForm(agent: AgentDefinition | null): AgentDefinition {
  return agent ? { ...agent } : { ...EMPTY_AGENT };
}

export function AgentsPanel() {
  const open = useSettingsStore((s) => s.agentsPanelOpen);
  const setOpen = useSettingsStore((s) => s.setAgentsPanelOpen);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const capabilityProjectId = useSettingsStore((s) => s.capabilityProjectId);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = capabilityProjectId || sessions.find((session) => session.id === activeSessionId)?.projectId || projects[0]?.id || '';
  const [projectId, setProjectId] = useState(activeProjectId);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AgentDefinition>(() => ({ ...EMPTY_AGENT }));
  const [runTask, setRunTask] = useState('');
  const [pendingRun, setPendingRun] = useState<{ agentId: string; task: string; at: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setProjectId((current) => capabilityProjectId || current || activeProjectId);
  }, [activeProjectId, capabilityProjectId, open]);

  useEffect(() => {
    const onSelect = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; agentId?: string }>).detail || {};
      if (detail.projectId) setProjectId(detail.projectId);
      if (detail.agentId) setSelectedId(detail.agentId);
    };
    window.addEventListener('tower-select-agent-definition', onSelect as EventListener);
    return () => window.removeEventListener('tower-select-agent-definition', onSelect as EventListener);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    setLoading(true);
    setError('');
    fetch(`/api/agents${params.toString() ? `?${params.toString()}` : ''}`, { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
        return res.json();
      })
      .then((data: AgentDefinition[]) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        setAgents(list);
        setSelectedId((current) => current && list.some((agent) => agent.id === current) ? current : list[0]?.id || '');
      })
      .catch((err) => {
        if (cancelled) return;
        setAgents([]);
        setSelectedId('');
        setError(err?.message || '에이전트 목록을 불러오지 못했습니다.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  const selected = useMemo(() => agents.find((agent) => agent.id === selectedId) || null, [agents, selectedId]);
  const projectName = projects.find((project) => project.id === projectId)?.name || '현재 프로젝트';

  const reloadAgents = async (preferredId?: string) => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    const res = await fetch(`/api/agents${params.toString() ? `?${params.toString()}` : ''}`, { headers: authHeaders() });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
    const data = await res.json() as AgentDefinition[];
    setAgents(Array.isArray(data) ? data : []);
    setSelectedId(preferredId || data[0]?.id || '');
  };

  const beginCreate = () => {
    setCreating(true);
    setEditing(true);
    setForm({ ...EMPTY_AGENT, visibility: 'background' });
  };

  const beginEdit = (agent: AgentDefinition) => {
    setCreating(false);
    setEditing(true);
    setForm(toForm(agent));
  };

  const cancelEdit = () => {
    setEditing(false);
    setCreating(false);
    setForm(toForm(selected));
  };

  const updateForm = (patch: Partial<AgentDefinition>) => setForm((current) => ({ ...current, ...patch }));

  const saveForm = async () => {
    if (!projectId) {
      toastError('프로젝트를 먼저 선택하세요.');
      return;
    }
    if (!form.id.trim() || !form.role.trim() || !form.instruction.trim()) {
      toastError('id, role, instruction은 필수입니다.');
      return;
    }
    setSaving(true);
    try {
      const method = creating ? 'POST' : 'PUT';
      const url = creating ? '/api/agents' : `/api/agents/${encodeURIComponent(selected?.id || form.id)}`;
      const body = {
        projectId,
        definition: {
          id: form.id.trim(),
          displayName: form.displayName?.trim() || undefined,
          role: form.role.trim(),
          instruction: form.instruction.trim(),
          goal: form.goal?.trim() || undefined,
          engine: form.engine || undefined,
          model: form.model?.trim() || undefined,
          visibility: form.visibility || 'background',
          permissions: form.permissions,
          report: form.report,
        },
      };
      const res = await fetch(url, {
        method,
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toastSuccess(creating ? '전문가를 추가했습니다.' : '전문가 설정을 저장했습니다.');
      setEditing(false);
      setCreating(false);
      await reloadAgents(data.id || form.id.trim());
    } catch (err: any) {
      toastError(err?.message || '에이전트 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const runSelectedAgent = (agent: AgentDefinition) => {
    const task = runTask.trim();
    if (!task) {
      toastError('맡길 일을 먼저 적어주세요.');
      return;
    }
    const command = `/agent ${agent.id} ${task}`;
    window.dispatchEvent(new CustomEvent('tower-run-agent-command', { detail: { command } }));
    setPendingRun({ agentId: agent.id, task, at: Date.now() });
    setRunTask('');
    toastSuccess(`${agent.displayName || agent.id}에게 맡겼습니다. 결과는 현재 채팅으로 돌아옵니다.`);
    window.setTimeout(() => {
      reloadAgents(agent.id).catch(() => {});
    }, 1500);
  };

  const copyRunCommand = async (agent: AgentDefinition) => {
    const command = `/agent ${agent.id} `;
    try {
      await navigator.clipboard.writeText(command);
      toastSuccess('명령어를 복사했습니다. 입력창에 붙여넣고 작업을 이어 적으세요.');
    } catch {
      toastError('클립보드 복사에 실패했습니다.');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative flex h-[min(92vh,860px)] w-[calc(100vw-24px)] max-w-[1120px] flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 shadow-2xl">
        <div className="shrink-0 flex items-center justify-between border-b border-surface-800 px-6 py-4">
          <div lang="ko" className="[word-break:keep-all] [overflow-wrap:break-word]">
            <h2 className="text-[17px] font-bold text-gray-100">전문가</h2>
            <p className="mt-0.5 text-[13px] text-surface-500">Primary AI 팀원이 필요할 때 함께 부르는 보조 역할을 설정하고 일을 맡깁니다.</p>
          </div>
          <button onClick={() => setOpen(false)} className="p-1 text-gray-500 transition-colors hover:text-gray-300" aria-label="Close agents panel">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[340px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-b border-surface-800 bg-surface-950/30 p-4 lg:border-b-0 lg:border-r">
            <label className="mb-3 block text-[12px] font-semibold uppercase tracking-wider text-surface-500">작업공간</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="mb-4 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[14px] text-surface-100 outline-none focus:border-primary-500/60"
            >
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>

            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-[12px] font-semibold uppercase tracking-wider text-surface-500">전문가 역할</div>
              <div className="flex items-center gap-2">
                {loading && <span className="text-[12px] text-surface-600">loading…</span>}
                <button onClick={beginCreate} className="rounded-md border border-primary-500/40 bg-primary-500/10 px-2 py-1 text-[12px] font-semibold text-primary-300 hover:bg-primary-500/15">추가</button>
              </div>
            </div>

            {error && <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[13px] text-red-300">{error}</div>}

            <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
              {agents.length === 0 && !loading ? (
                <div className="rounded-xl border border-dashed border-surface-700 bg-surface-950/40 p-4 text-[13px] leading-relaxed text-surface-500">
                  아직 등록된 전문가가 없습니다.<br />
                  <span className="font-mono text-surface-400">.tower/agents/*.agent.yaml</span> 파일을 추가하면 여기에 표시됩니다.
                </div>
              ) : agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedId(agent.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-all ${selectedId === agent.id ? 'border-primary-500/60 bg-primary-500/10' : 'border-surface-800 bg-surface-950/40 hover:border-surface-700 hover:bg-surface-900'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-semibold text-surface-100">{agent.displayName || agent.id}</div>
                      <div className="mt-0.5 truncate text-[12px] font-mono text-surface-500">{agent.id}</div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[11px] ${agent.worker ? 'border-emerald-500/30 text-emerald-300' : 'border-surface-700 text-surface-500'}`}>{agent.worker ? agent.worker.status : agent.visibility}</span>
                  </div>
                  <div className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-surface-400">{agent.role}</div>
                </button>
              ))}
            </div>
          </aside>

          <main className="min-h-0 overflow-auto p-5 lg:p-6">
            {editing ? (
              <div className="mx-auto max-w-3xl space-y-5">
                <div className="rounded-2xl border border-primary-500/25 bg-primary-500/5 p-5">
                  <div className="mb-5 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-xl font-bold text-surface-100">{creating ? '새 전문가 추가' : '전문가 설정 수정'}</h3>
                      <p className="mt-1 text-[13px] leading-relaxed text-surface-500">프로젝트의 <span className="font-mono">.tower/agents</span> YAML 파일로 저장됩니다.</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={cancelEdit} className="rounded-lg border border-surface-700 px-3 py-2 text-[13px] font-semibold text-surface-300 hover:bg-surface-800">취소</button>
                      <button disabled={saving} onClick={saveForm} className="rounded-lg border border-primary-500/40 bg-primary-500/15 px-3 py-2 text-[13px] font-semibold text-primary-300 hover:bg-primary-500/20 disabled:opacity-50">{saving ? '저장 중…' : '저장'}</button>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block text-[13px] font-semibold text-surface-400">ID
                      <input value={form.id} onChange={(e) => updateForm({ id: e.target.value })} placeholder="reviewer" className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-[14px] text-surface-100 outline-none focus:border-primary-500/60" />
                    </label>
                    <label className="block text-[13px] font-semibold text-surface-400">Display name
                      <input value={form.displayName || ''} onChange={(e) => updateForm({ displayName: e.target.value })} placeholder="리뷰어" className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[14px] text-surface-100 outline-none focus:border-primary-500/60" />
                    </label>
                    <label className="block text-[13px] font-semibold text-surface-400 md:col-span-2">Role
                      <input value={form.role} onChange={(e) => updateForm({ role: e.target.value })} placeholder="독립 코드 리뷰어" className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[14px] text-surface-100 outline-none focus:border-primary-500/60" />
                    </label>
                    <label className="block text-[13px] font-semibold text-surface-400 md:col-span-2">Instruction
                      <textarea value={form.instruction} onChange={(e) => updateForm({ instruction: e.target.value })} rows={8} placeholder="이 에이전트가 지켜야 할 역할, 범위, 보고 방식을 적습니다." className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[14px] leading-relaxed text-surface-100 outline-none focus:border-primary-500/60" />
                    </label>
                    <label className="block text-[13px] font-semibold text-surface-400 md:col-span-2">Goal <span className="font-normal text-surface-600">optional</span>
                      <input value={form.goal || ''} onChange={(e) => updateForm({ goal: e.target.value })} placeholder="반복 실행 시 유지할 목표" className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[14px] text-surface-100 outline-none focus:border-primary-500/60" />
                    </label>
                    <label className="block text-[13px] font-semibold text-surface-400">Engine
                      <select value={form.engine || ''} onChange={(e) => updateForm({ engine: (e.target.value || undefined) as AgentDefinition['engine'] })} className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[14px] text-surface-100 outline-none focus:border-primary-500/60">
                        <option value="">default</option>
                        <option value="pi">pi</option>
                        <option value="claude">claude</option>
                      </select>
                    </label>
                    <label className="block text-[13px] font-semibold text-surface-400">Visibility
                      <select value={form.visibility} onChange={(e) => updateForm({ visibility: e.target.value as AgentDefinition['visibility'] })} className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[14px] text-surface-100 outline-none focus:border-primary-500/60">
                        <option value="background">background</option>
                        <option value="sidebar">sidebar</option>
                        <option value="team">team</option>
                        <option value="system">system</option>
                      </select>
                    </label>
                    <label className="block text-[13px] font-semibold text-surface-400 md:col-span-2">Model <span className="font-normal text-surface-600">optional</span>
                      <input value={form.model || ''} onChange={(e) => updateForm({ model: e.target.value })} placeholder="litellm-responses/smartest" className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-[14px] text-surface-100 outline-none focus:border-primary-500/60" />
                    </label>
                  </div>
                </div>
              </div>
            ) : selected ? (
              <div className="mx-auto max-w-3xl space-y-5">
                <div className="rounded-2xl border border-surface-800 bg-surface-950/35 p-5 pb-0">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h3 className="text-xl font-bold text-surface-100">{selected.displayName || selected.id}</h3>
                      <p className="mt-1 font-mono text-[13px] text-surface-500">/agent {selected.id} &lt;task&gt;</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => beginEdit(selected)} className="rounded-lg border border-surface-700 px-3 py-2 text-[13px] font-semibold text-surface-300 transition-colors hover:bg-surface-800">수정</button>
                      <button onClick={() => copyRunCommand(selected)} className="rounded-lg border border-primary-500/40 bg-primary-500/10 px-3 py-2 text-[13px] font-semibold text-primary-300 transition-colors hover:bg-primary-500/15">
                        명령어 복사
                      </button>
                    </div>
                  </div>
                  <p className="mt-4 text-[15px] leading-relaxed text-surface-300">{selected.role}</p>
                  {pendingRun?.agentId === selected.id && (
                    <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-[13px] leading-relaxed text-amber-100">
                      <div className="font-semibold">실행 요청을 보냈습니다</div>
                      <div className="mt-1 text-amber-100/80">결과는 현재 채팅으로 돌아옵니다. 필요하면 이 패널을 열어둔 채 다른 preset도 확인할 수 있습니다.</div>
                      <div className="mt-2 truncate font-mono text-[12px] text-amber-100/70">/agent {selected.id} {pendingRun.task}</div>
                    </div>
                  )}
                  <div className="sticky bottom-0 z-10 -mx-5 mt-4 border-t border-primary-500/20 bg-surface-950/95 p-4 shadow-[0_-12px_32px_rgba(0,0,0,0.25)] backdrop-blur">
                    <label className="block text-[13px] font-semibold text-primary-300">이번에 맡길 일</label>
                    <textarea
                      value={runTask}
                      onChange={(e) => setRunTask(e.target.value)}
                      rows={3}
                      placeholder="예: 이번 변경사항을 리뷰하고 위험한 부분만 짚어줘"
                      className="mt-2 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-[14px] leading-relaxed text-surface-100 outline-none focus:border-primary-500/60"
                    />
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-[12px] text-surface-500">전송하면 현재 채팅에 명령이 들어가고, 완료 보고도 같은 채팅으로 돌아옵니다.</span>
                      <button onClick={() => runSelectedAgent(selected)} className="shrink-0 rounded-lg border border-primary-500/40 bg-primary-500/15 px-3 py-2 text-[13px] font-semibold text-primary-300 hover:bg-primary-500/20">이 조수에게 맡기기</button>
                    </div>
                  </div>
                  {selected.worker && (
                    <div className="mt-4 grid gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-[13px] text-surface-300 sm:grid-cols-3">
                      <div><span className="text-surface-500">worker</span><div className="mt-0.5 truncate font-mono text-emerald-200">{selected.worker.id.slice(0, 8)}</div></div>
                      <div><span className="text-surface-500">status</span><div className="mt-0.5 font-mono text-emerald-200">{selected.worker.status}</div></div>
                      <div><span className="text-surface-500">backing</span><div className="mt-0.5 truncate font-mono text-emerald-200">{selected.worker.backing_session_id ? selected.worker.backing_session_id.slice(0, 8) : '—'}</div></div>
                    </div>
                  )}
                </div>

                <section className="rounded-2xl border border-surface-800 bg-surface-950/25 p-5">
                  <h4 className="mb-3 text-[13px] font-bold uppercase tracking-wider text-surface-500">Instruction</h4>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-surface-800 bg-black/20 p-4 text-[13px] leading-relaxed text-surface-300">{selected.instruction}</pre>
                </section>

                {(selected.latestRun || selected.stateCard) && (
                  <section className="rounded-2xl border border-surface-800 bg-surface-950/25 p-5">
                    <h4 className="mb-3 text-[13px] font-bold uppercase tracking-wider text-surface-500">최근 활동</h4>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <div className="text-[12px] font-semibold uppercase tracking-wider text-surface-600">Latest run</div>
                        <div className="mt-2 rounded-xl border border-surface-800 bg-black/15 p-3 text-[13px] leading-relaxed text-surface-300">
                          {selected.latestRun ? (
                            <>
                              <div className="mb-1 font-mono text-surface-400">{selected.latestRun.status} · {selected.latestRun.id.slice(0, 8)}</div>
                              <div>{selected.latestRun.result_summary || selected.latestRun.error || '아직 요약이 없습니다.'}</div>
                              {Array.isArray(selected.latestRun.artifact_paths) && selected.latestRun.artifact_paths.length > 0 && (
                                <div className="mt-2 space-y-1 text-[12px] text-surface-500">
                                  <div className="font-semibold uppercase tracking-wider">Detail artifacts</div>
                                  {selected.latestRun.artifact_paths.slice(0, 5).map((artifactPath, index) => (
                                    <div key={`${index}-${String(artifactPath)}`} className="font-mono break-all">{String(artifactPath)}</div>
                                  ))}
                                </div>
                              )}
                            </>
                          ) : '아직 실행 기록이 없습니다.'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[12px] font-semibold uppercase tracking-wider text-surface-600">State card</div>
                        <div className="mt-2 rounded-xl border border-surface-800 bg-black/15 p-3 text-[13px] leading-relaxed text-surface-300">
                          {selected.stateCard ? (
                            <>
                              <div className="mb-1 text-surface-400">{selected.stateCard.current_focus || selected.stateCard.goal || '현재 상태'}</div>
                              <div>{selected.stateCard.next_action || selected.stateCard.last_action || '다음 액션이 없습니다.'}</div>
                            </>
                          ) : '아직 상태 카드가 없습니다.'}
                        </div>
                      </div>
                    </div>
                    {selected.worker?.backing_session_id && (
                      <div className="mt-3 text-[13px] text-surface-500">Backing session: <span className="font-mono text-surface-300">{selected.worker.backing_session_id}</span></div>
                    )}
                  </section>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  <section className="rounded-2xl border border-surface-800 bg-surface-950/25 p-4">
                    <h4 className="mb-3 text-[13px] font-bold uppercase tracking-wider text-surface-500">Runtime</h4>
                    <dl className="space-y-2 text-[13px]">
                      <div className="flex justify-between gap-3"><dt className="text-surface-500">engine</dt><dd className="font-mono text-surface-300">{selected.engine || 'default'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-surface-500">model</dt><dd className="max-w-[220px] truncate font-mono text-surface-300">{selected.model || 'default'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-surface-500">visibility</dt><dd className="font-mono text-surface-300">{selected.visibility}</dd></div>
                    </dl>
                  </section>
                  <section className="rounded-2xl border border-surface-800 bg-surface-950/25 p-4">
                    <h4 className="mb-3 text-[13px] font-bold uppercase tracking-wider text-surface-500">Policy</h4>
                    <dl className="space-y-2 text-[13px]">
                      <div><dt className="text-surface-500">permissions</dt><dd className="mt-1 break-all font-mono text-surface-300">{compactJson(selected.permissions)}</dd></div>
                      <div><dt className="text-surface-500">report</dt><dd className="mt-1 break-all font-mono text-surface-300">{compactJson(selected.report)}</dd></div>
                    </dl>
                  </section>
                </div>

                <section className="rounded-2xl border border-surface-800 bg-surface-950/25 p-4">
                  <h4 className="mb-2 text-[13px] font-bold uppercase tracking-wider text-surface-500">Source</h4>
                  <div className="font-mono text-[13px] text-surface-400">{sourceRelative(selected.sourcePath)}</div>
                  <p className="mt-3 text-[13px] leading-relaxed text-surface-500">
                    이 화면의 수정 버튼으로 기본 필드를 편집할 수 있습니다. 고급 permissions/report는 아직 파일 직접 편집을 사용합니다.
                  </p>
                </section>
              </div>
            ) : (
              <div className="flex h-full min-h-[360px] items-center justify-center">
                <div className="max-w-md rounded-2xl border border-dashed border-surface-700 bg-surface-950/30 p-6 text-center">
                  <div className="text-lg font-bold text-surface-200">{projectName}에 등록된 전문가가 없습니다</div>
                  <p className="mt-2 text-[14px] leading-relaxed text-surface-500">
                    전문가는 Primary AI 팀원이 검토·리서치·품질 확인처럼 필요한 순간에 함께 부르는 보조 역할입니다. 이 화면에서 역할을 추가하고 바로 일을 맡길 수 있습니다.
                  </p>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
