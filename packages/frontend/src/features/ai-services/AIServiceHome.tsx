import React from 'react';
import i18n from '../../i18n';
import type { Project } from '@tower/shared';
import { AgentIdentityAvatar } from '../agent-profile/AgentIdentityAvatar';
import { useConfirm } from '../../hooks/useDialog';
import { useAIServiceStore, type AIServiceChannelAccessMode, type AIServiceChannelUsageSummary, type AIServiceConversationSummary, type AIServicePublicUiConfig, type AIServiceSummary } from './ai-services-store';

const FILTERS = [
  ['all', '전체'], ['active', '운영 중'], ['draft', '배포 준비'], ['review', '검토 중'], ['paused', '접근 중지'],
] as const;

const QUICK_WEB_HARNESS = {
  id: 'quick-web-research',
  version: 1,
  profileId: 'web-only',
  profileVersion: 1,
  engine: 'Pi',
  model: 'Smart',
  capabilities: [
    { id: 'web.search', tool: 'WebSearch', label: '공개 웹 검색', detail: '공개 웹에서 최신 자료를 찾습니다.' },
    { id: 'web.fetch', tool: 'WebFetch', label: '웹페이지 읽기', detail: '선택한 검색 결과의 원문을 읽습니다.' },
  ],
} as const;

type CreateMode = 'published' | 'custom-draft';
type ChannelSummary = NonNullable<AIServiceSummary['channels']>[number];
type EffectiveHarness = {
  id: string;
  version: number;
  runtimeProfileId: string;
  runtimeProfileVersion: number;
  engine: 'pi' | 'claude';
  defaultModel: string | null;
  capabilityIds: string[];
};
type PublishedHarness = {
  id: string;
  name: string;
  description?: string;
  current_version: number;
  engine?: 'pi' | 'claude';
  runtime_profile_id?: string;
  runtime_profile_version?: number;
  effective_manifest?: Partial<EffectiveHarness> & { runtimeProfile?: { id?: string; version?: number } };
};

type KnowledgePickerEntry = { name: string; path: string; isDirectory: boolean; size?: number; children?: KnowledgePickerEntry[] };
const KNOWLEDGE_EXTENSIONS = new Set(['.md', '.txt']);
const KNOWLEDGE_PROMPT_TOKEN_LIMIT = 40_000;

function knowledgeExtension(name: string): string { const dot = name.lastIndexOf('.'); return dot >= 0 ? name.slice(dot).toLowerCase() : ''; }
function relativeKnowledgePath(rootPath: string, filePath: string): string { return filePath.slice(rootPath.replace(/\/$/, '').length).replace(/^\/+/, ''); }

function KnowledgeFilePicker({ project, selected, onApply, onClose }: { project: { rootPath?: string; name: string }; selected: string[]; onApply: (paths: string[]) => void; onClose: () => void }) {
  const rootPath = project.rootPath || '';
  const [currentPath, setCurrentPath] = React.useState(rootPath);
  const [entries, setEntries] = React.useState<KnowledgePickerEntry[]>([]);
  const [chosen, setChosen] = React.useState<Set<string>>(new Set(selected));
  const [sizes, setSizes] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const loadDirectory = React.useCallback(async (nextPath: string) => {
    if (!nextPath) return;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/files/tree?path=${encodeURIComponent(nextPath)}`, { headers: authJsonHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '자료 목록을 불러오지 못했습니다.');
      const rows = Array.isArray(body.entries) ? body.entries as KnowledgePickerEntry[] : [];
      setEntries(rows.filter((item) => item.isDirectory || KNOWLEDGE_EXTENSIONS.has(knowledgeExtension(item.name))).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'ko')));
      setCurrentPath(nextPath);
    } catch (cause) { setEntries([]); setError(cause instanceof Error ? cause.message : '자료 목록을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void loadDirectory(rootPath); }, [loadDirectory, rootPath]);
  const toggle = (entry: KnowledgePickerEntry) => {
    const relative = relativeKnowledgePath(rootPath, entry.path);
    setChosen((current) => { const next = new Set(current); if (next.has(relative)) next.delete(relative); else next.add(relative); return next; });
    setSizes((current) => ({ ...current, [relative]: Number(entry.size || 0) }));
  };
  const selectedBytes = [...chosen].reduce((sum, value) => sum + Number(sizes[value] || 0), 0);
  const estimatedTokens = Math.ceil(selectedBytes / 3);
  const overLimit = estimatedTokens > KNOWLEDGE_PROMPT_TOKEN_LIMIT;
  const parentPath = currentPath !== rootPath ? currentPath.slice(0, currentPath.lastIndexOf('/')) : null;
  return <div className="fixed inset-0 z-[140] grid place-items-center bg-black/70 p-4" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="Finder에서 답변 자료 선택" className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-surface-700 dark:bg-surface-900" onClick={(event) => event.stopPropagation()}>
      <header className="border-b border-slate-200 px-5 py-4 dark:border-surface-800"><div className="text-sm font-bold text-slate-950 dark:text-surface-100">Finder에서 답변 자료 선택</div><p className="mt-1 text-xs text-slate-500 dark:text-surface-500">{project.name} 안의 Markdown·TXT 문헌만 배포본에 복사됩니다.</p></header>
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-surface-800"><button type="button" disabled={!parentPath} onClick={() => parentPath && void loadDirectory(parentPath)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-35 dark:border-surface-700">상위</button><code className="min-w-0 truncate text-xs text-slate-500 dark:text-surface-500">{relativeKnowledgePath(rootPath, currentPath) || '/'}</code></div>
      <div className="min-h-64 flex-1 overflow-y-auto p-3">{loading ? <div className="p-8 text-center text-sm text-slate-500">불러오는 중…</div> : error ? <div className="p-8 text-center text-sm text-red-600">{error}</div> : entries.length === 0 ? <div className="p-8 text-center text-sm text-slate-500">선택 가능한 문헌이 없습니다.</div> : entries.map((entry) => entry.isDirectory ? <button key={entry.path} type="button" onClick={() => void loadDirectory(entry.path)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-surface-800"><span>📁</span><span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span><span className="text-xs text-slate-400">열기</span></button> : <label key={entry.path} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-slate-100 dark:hover:bg-surface-800"><input type="checkbox" checked={chosen.has(relativeKnowledgePath(rootPath, entry.path))} onChange={() => toggle(entry)} /><span>📄</span><span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span><span className="text-xs text-slate-400">{Number(entry.size || 0).toLocaleString()} B</span></label>)}</div>
      <footer className="border-t border-slate-200 px-5 py-4 dark:border-surface-800"><div className={`mb-3 text-xs ${overLimit ? 'text-red-700 dark:text-red-300' : 'text-slate-500 dark:text-surface-500'}`}>{chosen.size}개 · 약 {selectedBytes.toLocaleString()} bytes · 예상 {estimatedTokens.toLocaleString()} tokens {overLimit ? `· 안전 상한 ${KNOWLEDGE_PROMPT_TOKEN_LIMIT.toLocaleString()} 초과` : ''}</div><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-surface-700">취소</button><button type="button" disabled={overLimit} onClick={() => onApply([...chosen].sort())} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-bold text-white disabled:bg-slate-300 dark:disabled:bg-surface-700">{chosen.size}개 자료 선택</button></div></footer>
    </section>
  </div>;
}

const CAPABILITY_COPY: Record<string, { tool: string; label: string; detail: string }> = {
  'web.search': { tool: 'WebSearch', label: '공개 웹 검색', detail: '공개 웹에서 최신 자료를 찾습니다.' },
  'web.fetch': { tool: 'WebFetch', label: '웹페이지 읽기', detail: '선택한 검색 결과의 원문을 읽습니다.' },
};

function effectiveHarness(item: PublishedHarness): EffectiveHarness {
  if (item.id === QUICK_WEB_HARNESS.id) return {
    id: item.id, version: item.current_version, runtimeProfileId: QUICK_WEB_HARNESS.profileId,
    runtimeProfileVersion: QUICK_WEB_HARNESS.profileVersion, engine: 'pi',
    defaultModel: 'litellm-responses/smart', capabilityIds: QUICK_WEB_HARNESS.capabilities.map((capability) => capability.id),
  };
  const manifest = item.effective_manifest || {};
  const runtimeProfileId = String(manifest.runtimeProfileId || manifest.runtimeProfile?.id || item.runtime_profile_id || '');
  const runtimeProfileVersion = Number(manifest.runtimeProfileVersion || manifest.runtimeProfile?.version || item.runtime_profile_version || 1);
  return {
    id: item.id, version: Number(manifest.version || item.current_version),
    runtimeProfileId,
    runtimeProfileVersion, engine: item.engine === 'claude' ? 'claude' : 'pi',
    defaultModel: typeof manifest.defaultModel === 'string' ? manifest.defaultModel : null,
    capabilityIds: Array.isArray(manifest.capabilityIds) ? manifest.capabilityIds : [],
  };
}

function harnessSlug(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function tone(status: string) {
  if (status === 'active') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200';
  if (status === 'review') return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200';
  if (status === 'paused') return 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-200';
  return 'border-surface-700 bg-surface-800/60 text-surface-500 dark:text-surface-300';
}

function label(status: string) {
  if (status === 'active' || status === 'review' || status === 'paused' || status === 'draft') {
    return i18n.t(`aiServices.status.${status}`);
  }
  return status;
}

const ACCESS_MODE_LABELS: Record<AIServiceChannelAccessMode, string> = {
  public: '완전 공개 · 누구나 접속',
  unlisted: '링크 공유 · 링크를 아는 사람만',
  password: '비밀번호 보호 · 비밀번호를 아는 사람만',
  login_required: '로그인 필요 · 준비 중',
  disabled: '일시 중지 · 아무도 접속 못함',
};

function channelAccessMode(channel?: ChannelSummary): AIServiceChannelAccessMode {
  const mode = channel?.accessMode;
  return mode === 'public' || mode === 'password' || mode === 'login_required' || mode === 'disabled' ? mode : 'unlisted';
}

function channelPublicUi(channel?: ChannelSummary): Required<AIServicePublicUiConfig> {
  return {
    showInfoPanel: channel?.publicUi?.showInfoPanel !== false,
    showTools: channel?.publicUi?.showTools !== false,
    showMaterials: channel?.publicUi?.showMaterials !== false,
    showTiming: channel?.publicUi?.showTiming !== false,
  };
}

function isExternallyAccessible(service: AIServiceSummary, channel?: ChannelSummary) {
  return service.status === 'active' && channel?.status === 'enabled' && channelAccessMode(channel) !== 'disabled';
}

function isAccessStopped(service: AIServiceSummary, channel?: ChannelSummary) {
  return service.status === 'paused' || channelAccessMode(channel) === 'disabled';
}

function operationalFilter(service: AIServiceSummary): 'active' | 'draft' | 'review' | 'paused' {
  const channel = service.channels?.find((item) => item.status === 'enabled') || service.channels?.[0];
  if (isAccessStopped(service, channel)) return 'paused';
  if (isExternallyAccessible(service, channel)) return 'active';
  if (service.status === 'review') return 'review';
  return 'draft';
}

function deploymentKnowledgeRefs(service: AIServiceSummary) {
  return service.currentDeployment?.sourceSnapshot?.refs?.filter((ref) => typeof ref.path === 'string' && ref.path) || [];
}

function shortDate(value?: string | null) {
  if (!value) return '아직 배포 전';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '날짜 확인 필요' : new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function exposureLabel(service: AIServiceSummary, channel?: ChannelSummary) {
  const mode = channelAccessMode(channel);
  if (mode === 'disabled' || mode === 'password' || mode === 'login_required') {
    return i18n.t(`aiServices.exposure.${mode === 'login_required' ? 'loginRequired' : mode}`);
  }
  if (service.status === 'active' && channel?.status === 'enabled') {
    return i18n.t(`aiServices.exposure.${mode === 'public' ? 'publicActive' : 'linkActive'}`);
  }
  if (service.status === 'active' || service.status === 'review' || service.status === 'paused') {
    return i18n.t(`aiServices.exposure.${service.status}`);
  }
  return i18n.t('aiServices.exposure.notPublished');
}

type ChannelCredentialResponse = {
  token: string;
  expiresAt: string;
  serving?: { conversationUrl?: string; messageUrlTemplate?: string; chatUrlTemplate?: string; authorization?: string; exposure?: string; robots?: string };
};

function authJsonHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function copyText(value: string) {
  if (!value) return;
  await navigator.clipboard?.writeText(value).catch(() => undefined);
}

function previewAnswerText(value: unknown): string {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof body.text === 'string') return body.text;
  if (typeof body.answer === 'string') return body.answer;
  const message = body.message && typeof body.message === 'object' ? body.message as Record<string, unknown> : {};
  return typeof message.text === 'string' ? message.text : '';
}

function makeSharePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(10);
  window.crypto?.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => alphabet[byte % alphabet.length]).join('');
}

type RequestActionDraft = { enabled: boolean; label: string; description: string; confirmationLabel: string; subjectPrefix: string; recipientEmail: string; collectName: boolean; collectEmail: boolean; collectPhone: boolean };

const EMPTY_REQUEST_ACTION: RequestActionDraft = { enabled: false, label: '우리 고객사에 요청 보내기', description: '대화 내용을 정리해 담당자에게 접수합니다.', confirmationLabel: '이 내용으로 요청 보내기', subjectPrefix: 'AI Service 고객 요청', recipientEmail: '', collectName: true, collectEmail: true, collectPhone: false };

function requestActionDraft(experienceSnapshot?: Record<string, unknown>): RequestActionDraft {
  const raw = Array.isArray(experienceSnapshot?.requestActions) && experienceSnapshot.requestActions[0] && typeof experienceSnapshot.requestActions[0] === 'object' ? experienceSnapshot.requestActions[0] as Record<string, unknown> : null;
  if (!raw) return EMPTY_REQUEST_ACTION;
  const destination = raw.destination && typeof raw.destination === 'object' ? raw.destination as Record<string, unknown> : {};
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  return { enabled: true, label: String(raw.label || EMPTY_REQUEST_ACTION.label), description: String(raw.description || ''), confirmationLabel: String(raw.confirmationLabel || EMPTY_REQUEST_ACTION.confirmationLabel), subjectPrefix: String(raw.subjectPrefix || EMPTY_REQUEST_ACTION.subjectPrefix), recipientEmail: String(destination.to || ''), collectName: fields.includes('name'), collectEmail: fields.includes('email'), collectPhone: fields.includes('phone') };
}

function requestActionsSnapshot(draft: RequestActionDraft): Array<Record<string, unknown>> {
  if (!draft.enabled) return [];
  return [{ id: 'contact-company', label: draft.label.trim(), description: draft.description.trim(), confirmationLabel: draft.confirmationLabel.trim(), subjectPrefix: draft.subjectPrefix.trim(), fields: [draft.collectName && 'name', draft.collectEmail && 'email', draft.collectPhone && 'phone'].filter(Boolean), destination: { type: 'email', to: draft.recipientEmail.trim() } }];
}

function DeploymentVersionPanel({ service }: { service: AIServiceSummary }) {
  const createDeployment = useAIServiceStore((s) => s.createDeployment);
  const deployNow = useAIServiceStore((s) => s.deployNow);
  const rollbackDeployment = useAIServiceStore((s) => s.rollbackDeployment);
  const mutating = useAIServiceStore((s) => s.mutatingId === service.id);
  const current = service.currentDeployment;
  const currentPaths = deploymentKnowledgeRefs(service).map((ref) => ref.path!).filter(Boolean);
  const [open, setOpen] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [nextPaths, setNextPaths] = React.useState<string[]>(currentPaths);
  const [requestAction, setRequestAction] = React.useState<RequestActionDraft>(() => requestActionDraft(current?.experienceSnapshot));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => { setNextPaths(currentPaths); setRequestAction(requestActionDraft(current?.experienceSnapshot)); }, [service.id, current?.id]);
  if (!current) return null;
  const previous = service.deployments?.find((item) => item.status === 'superseded');
  const added = nextPaths.filter((path) => !currentPaths.includes(path));
  const removed = currentPaths.filter((path) => !nextPaths.includes(path));
  const unchanged = nextPaths.filter((path) => currentPaths.includes(path));
  const currentRequestAction = requestActionDraft(current.experienceSnapshot);
  const requestActionChanged = JSON.stringify(requestAction) !== JSON.stringify(currentRequestAction);
  const changed = added.length > 0 || removed.length > 0 || requestActionChanged;
  const requestActionValid = !requestAction.enabled || Boolean(requestAction.label.trim() && requestAction.confirmationLabel.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestAction.recipientEmail.trim()));
  const createNext = async () => {
    if (!changed || !requestActionValid) return;
    setBusy(true); setError('');
    try {
      const next = await createDeployment(service.id, {
        sourceSnapshot: nextPaths.length ? { kind: 'knowledge', version: 1, refs: nextPaths.map((path) => ({ path })) } : { kind: 'none', version: 1, refs: [], userFacingLabel: '연결된 배포 자료 없음' },
        policySnapshot: current.policySnapshot || {},
        experienceSnapshot: { ...(current.experienceSnapshot || { greeting: '안녕하세요. 승인된 배포 자료를 바탕으로 근거와 함께 답변합니다.' }), requestActions: requestActionsSnapshot(requestAction) },
        evaluationSnapshot: { status: 'not_run', cases: [] },
      });
      await deployNow(service.id, next.id);
      setOpen(false);
    } catch (err) { setError(err instanceof Error ? err.message : '새 버전을 활성화하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const rollback = async () => {
    if (!previous) return;
    setBusy(true); setError('');
    try { await rollbackDeployment(service.id, previous.id); }
    catch (err) { setError(err instanceof Error ? err.message : '이전 버전으로 되돌리지 못했습니다.'); }
    finally { setBusy(false); }
  };
  return <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-surface-800 dark:bg-surface-950/45" aria-label="배포 버전 관리">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-bold text-slate-900 dark:text-surface-100">배포 버전</div><p className="mt-1 text-xs leading-5 text-slate-500 dark:text-surface-500">현재 버전을 보존한 채 문헌 구성을 바꾼 새 버전을 만들 수 있습니다.</p></div><div className="flex gap-2"><button type="button" onClick={() => setOpen((value) => !value)} className="rounded-lg border border-teal-300 bg-teal-50 px-3 py-2 text-xs font-bold text-teal-800 hover:bg-teal-100 dark:border-primary-500/35 dark:bg-primary-500/10 dark:text-primary-200">{open ? '준비 닫기' : '새 버전 준비'}</button>{previous && <button type="button" disabled={busy || mutating} onClick={() => void rollback()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-surface-700 dark:bg-transparent dark:text-surface-300">v{previous.version}로 되돌리기</button>}</div></div>
    <div className="mt-3 flex flex-wrap gap-2 text-[11px]"><span className="rounded-full bg-emerald-50 px-2 py-1 font-bold text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">현재 v{current.version}</span>{(service.deployments || []).slice(0, 4).map((item) => <span key={item.id} className="rounded-full border border-slate-200 px-2 py-1 text-slate-500 dark:border-surface-700 dark:text-surface-500">v{item.version} · {item.status === 'active' ? '운영 중' : item.status === 'superseded' ? '이전 버전' : item.status}</span>)}</div>
    {open && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-surface-800 dark:bg-surface-900/45"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-bold text-slate-800 dark:text-surface-200">v{current.version + 1} Knowledge 구성</div><p className="mt-1 text-[11px] text-slate-500 dark:text-surface-500">선택 시점의 파일 내용이 새 불변 snapshot으로 복사됩니다.</p></div><button type="button" disabled={!service.ownerProjectRootPath} onClick={() => setPickerOpen(true)} className="rounded-lg border border-teal-300 bg-white px-3 py-2 text-xs font-bold text-teal-800 disabled:opacity-50 dark:border-primary-500/35 dark:bg-transparent dark:text-primary-200">Finder에서 다시 선택</button></div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3"><div className="rounded-lg border border-emerald-200 bg-white p-3 dark:border-emerald-500/20 dark:bg-surface-950/50"><div className="text-[11px] font-bold text-emerald-800 dark:text-emerald-200">추가 {added.length}</div>{added.slice(0, 3).map((path) => <div key={path} className="mt-1 truncate font-mono text-[10px] text-emerald-700 dark:text-emerald-300">+ {path}</div>)}</div><div className="rounded-lg border border-red-200 bg-white p-3 dark:border-red-500/20 dark:bg-surface-950/50"><div className="text-[11px] font-bold text-red-700 dark:text-red-200">제외 {removed.length}</div>{removed.slice(0, 3).map((path) => <div key={path} className="mt-1 truncate font-mono text-[10px] text-red-600 dark:text-red-300">− {path}</div>)}</div><div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-surface-700 dark:bg-surface-950/50"><div className="text-[11px] font-bold text-slate-700 dark:text-surface-300">유지 {unchanged.length}</div><div className="mt-1 text-[10px] text-slate-500 dark:text-surface-500">현재 버전과 같은 경로</div></div></div>
      <section className="mt-4 border-t border-slate-200 pt-4 dark:border-surface-700" aria-label="고객 요청 버튼 설정"><label className="flex items-center justify-between gap-3"><span><span className="block text-xs font-bold text-slate-800 dark:text-surface-200">고객 요청 버튼</span><span className="mt-1 block text-[11px] text-slate-500 dark:text-surface-500">고객이 확인한 내용을 사전 지정한 담당 메일로 접수합니다.</span></span><input type="checkbox" checked={requestAction.enabled} onChange={(event) => setRequestAction((current) => ({ ...current, enabled: event.target.checked }))} /></label>{requestAction.enabled && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400">버튼 문구<input value={requestAction.label} onChange={(event) => setRequestAction((current) => ({ ...current, label: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400">담당 메일<input type="email" value={requestAction.recipientEmail} onChange={(event) => setRequestAction((current) => ({ ...current, recipientEmail: event.target.value }))} placeholder="support@example.com" className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400 sm:col-span-2">설명<input value={requestAction.description} onChange={(event) => setRequestAction((current) => ({ ...current, description: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400">확인 버튼 문구<input value={requestAction.confirmationLabel} onChange={(event) => setRequestAction((current) => ({ ...current, confirmationLabel: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><label className="text-[11px] font-semibold text-slate-600 dark:text-surface-400">메일 제목 접두어<input value={requestAction.subjectPrefix} onChange={(event) => setRequestAction((current) => ({ ...current, subjectPrefix: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label><div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-surface-400 sm:col-span-2"><label><input type="checkbox" checked={requestAction.collectName} onChange={(event) => setRequestAction((current) => ({ ...current, collectName: event.target.checked }))} /> 이름 받기</label><label><input type="checkbox" checked={requestAction.collectEmail} onChange={(event) => setRequestAction((current) => ({ ...current, collectEmail: event.target.checked }))} /> 이메일 받기</label><label><input type="checkbox" checked={requestAction.collectPhone} onChange={(event) => setRequestAction((current) => ({ ...current, collectPhone: event.target.checked }))} /> 연락처 받기</label></div>{!requestActionValid && <div className="text-[11px] text-red-700 dark:text-red-300 sm:col-span-2">버튼 문구, 확인 문구와 올바른 담당 메일을 입력해 주세요.</div>}<p className="text-[11px] leading-5 text-slate-500 dark:text-surface-500 sm:col-span-2">수신 주소는 고객 화면에 노출되지 않습니다. Delivery Adapter가 연결되기 전에는 접수 기록만 남고 발송 완료로 표시되지 않습니다.</p></div>}</section>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-[11px] leading-5 text-slate-500 dark:text-surface-500">활성화하면 현재 v{current.version}은 이전 버전으로 보존되고 기존 외부 URL은 v{current.version + 1}을 사용합니다.</p><button type="button" disabled={!changed || !requestActionValid || busy || mutating} onClick={() => void createNext()} className="rounded-lg border border-teal-300 bg-teal-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100">{busy ? '새 버전 활성화 중…' : `v${current.version + 1} 만들고 활성화`}</button></div>{!changed && <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">Knowledge와 고객 요청 설정이 현재 버전과 같습니다. 변경 후 새 버전을 만들 수 있습니다.</div>}{error && <div className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</div>}</div>}
    {pickerOpen && service.ownerProjectRootPath && <KnowledgeFilePicker project={{ rootPath: service.ownerProjectRootPath, name: service.ownerAgentName || service.name }} selected={nextPaths} onApply={(paths) => { setNextPaths(paths); setPickerOpen(false); }} onClose={() => setPickerOpen(false)} />}
  </section>;
}

function DeploymentFlowPanel({ service, channel }: { service: AIServiceSummary; channel?: ChannelSummary }) {
  const deployNow = useAIServiceStore((s) => s.deployNow);
  const mutating = useAIServiceStore((s) => s.mutatingId === service.id);
  const [error, setError] = React.useState('');
  const deployment = service.latestDeployment || service.latest_deployment || service.currentDeployment || null;
  const publish = async () => {
    if (!deployment?.id) return;
    setError('');
    try { await deployNow(service.id, deployment.id); }
    catch (err) { setError(err instanceof Error ? err.message : '배포하지 못했습니다.'); }
  };
  if (isExternallyAccessible(service, channel)) return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-white/80 p-3 text-xs text-emerald-800 dark:border-emerald-500/25 dark:bg-surface-950/35 dark:text-emerald-200">
      <span><span className="font-bold">외부 배포 운영 중 · </span>아래 링크를 열어 직접 테스트하거나 복사해 공유하세요.</span>
      <span className="rounded-full bg-emerald-100 px-2 py-1 font-bold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200">정상</span>
    </div>
  );
  if (service.status === 'active' && channel?.status === 'enabled' && channelAccessMode(channel) === 'disabled') return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/8 dark:text-amber-200">
      <span><span className="font-bold">외부 접근 중지 · </span>기존 링크와 과거 대화는 보존되지만 외부 사용자는 대화할 수 없습니다.</span>
      <span className="rounded-full bg-amber-100 px-2 py-1 font-bold text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">접근 차단</span>
    </div>
  );
  return (
    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-500/25 dark:bg-emerald-500/8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="text-sm font-bold text-emerald-900 dark:text-emerald-100">{service.status === 'paused' ? '외부 배포가 멈춰 있습니다' : '아직 외부 배포되지 않았습니다'}</div><p className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-200/75">버튼 한 번이면 필요한 준비를 자동으로 끝내고 테스트 링크를 만듭니다.</p></div>
        <button type="button" disabled={!deployment?.id || mutating} onClick={() => void publish()} className="rounded-xl border border-emerald-500/35 bg-emerald-600 px-5 py-3 text-sm font-black text-white shadow-sm hover:bg-emerald-500 disabled:border-emerald-200 disabled:bg-emerald-100 disabled:text-emerald-500 disabled:shadow-none dark:disabled:border-emerald-900 dark:disabled:bg-emerald-950 dark:disabled:text-emerald-700">{mutating ? '외부 배포 중…' : service.status === 'paused' ? '다시 운영하기' : '에이전트 외부 배포'}</button>
      </div>
      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200">{error}</div>}
    </div>
  );
}

function quotaTone(status?: string) {
  if (status === 'exceeded') return 'text-red-700 dark:text-red-300';
  if (status === 'near') return 'text-amber-700 dark:text-amber-300';
  return 'text-emerald-700 dark:text-emerald-300';
}

function ChannelUsagePanel({ service, channel }: { service: AIServiceSummary; channel?: ChannelSummary }) {
  const getChannelUsage = useAIServiceStore((s) => s.getChannelUsage);
  const updateChannelQuota = useAIServiceStore((s) => s.updateChannelQuota);
  const [open, setOpen] = React.useState(false);
  const [usage, setUsage] = React.useState<AIServiceChannelUsageSummary | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [quotaDraft, setQuotaDraft] = React.useState({ windowSeconds: 60, channelLimit: 120, tenantLimit: 30, tenantDailyLimit: 1000, tokenLimit: 1_000_000 });
  const syncDraft = (next: AIServiceChannelUsageSummary) => setQuotaDraft({ windowSeconds: next.windowSeconds, channelLimit: next.channelLimit, tenantLimit: next.tenantLimit, tenantDailyLimit: next.tenantDailyLimit, tokenLimit: next.tokenLimit });
  const load = async () => {
    if (!channel) return;
    setLoading(true); setError('');
    try { const next = await getChannelUsage(service.id, channel.id); setUsage(next); syncDraft(next); }
    catch (err) { setError(err instanceof Error ? err.message : '사용량을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  };
  const saveQuota = async () => {
    if (!channel) return;
    setSaving(true); setError('');
    try { const next = await updateChannelQuota(service.id, channel.id, quotaDraft); setUsage(next); syncDraft(next); }
    catch (err) { setError(err instanceof Error ? err.message : 'Quota를 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };
  const setQuotaField = (key: keyof typeof quotaDraft, value: string) => setQuotaDraft((current) => ({ ...current, [key]: Math.max(1, Math.floor(Number(value) || 1)) }));
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-surface-800 dark:bg-surface-950/45">
      <button type="button" onClick={() => { setOpen((value) => !value); if (!open && !usage) void load(); }} className="flex w-full items-center justify-between gap-3 text-left">
        <span><span className="text-xs font-bold text-slate-900 dark:text-surface-200">사용량 · 로그</span><span className="ml-2 text-[11px] text-slate-500 dark:text-surface-600">최근 이용 현황과 사용 한도</span></span>
        <span className="text-xs font-semibold text-teal-700 dark:text-primary-300">{open ? '닫기' : '열기'}</span>
      </button>
      {open && <div className="mt-3 grid gap-3 md:grid-cols-5">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">최근 메시지</div><div className={`mt-1 text-lg font-bold ${quotaTone(usage?.quota.status)}`}>{usage?.channelMessageTurns ?? '—'} / {usage?.channelLimit ?? '—'}</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">{usage?.windowSeconds ?? '—'}초 기준</div></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">방문자 한도</div><div className="mt-1 text-lg font-bold text-slate-900 dark:text-surface-200">{usage?.tenantLimit ?? '—'}회</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">하루 {usage?.tenantDailyLimit ?? '—'}회</div></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">대화 수</div><div className="mt-1 text-lg font-bold text-slate-900 dark:text-surface-200">{usage?.conversationsCreated ?? '—'}</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">24시간 메시지 {usage?.channelDailyMessageTurns ?? '—'}</div></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">남은 요청</div><div className="mt-1 text-lg font-bold text-slate-900 dark:text-surface-200">{usage?.quota.channelRemaining ?? '—'}</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">외부 연결 {usage?.credentialIssued ?? '—'}개</div></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45"><div className="text-[11px] text-slate-500 dark:text-surface-600">토큰 사용량</div><div className="mt-1 text-lg font-bold text-slate-900 dark:text-surface-200">{(usage?.totalTokens ?? 0).toLocaleString()}</div><div className="mt-1 text-[10px] text-slate-400 dark:text-surface-600">한도 {(usage?.tokenLimit ?? 0).toLocaleString()}</div></div>
        <details className="md:col-span-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/45">
          <summary className="cursor-pointer text-[11px] font-bold text-slate-700 dark:text-surface-300">고급 이용 한도 설정</summary>
          <div className="mt-3 grid gap-2 md:grid-cols-5">
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">집계 시간(초)<input type="number" min={1} value={quotaDraft.windowSeconds} onChange={(event) => setQuotaField('windowSeconds', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">전체 요청 한도<input type="number" min={1} value={quotaDraft.channelLimit} onChange={(event) => setQuotaField('channelLimit', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">방문자별 요청 한도<input type="number" min={1} value={quotaDraft.tenantLimit} onChange={(event) => setQuotaField('tenantLimit', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">방문자별 하루 한도<input type="number" min={1} value={quotaDraft.tenantDailyLimit} onChange={(event) => setQuotaField('tenantDailyLimit', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">전체 토큰 한도<input type="number" min={1} value={quotaDraft.tokenLimit} onChange={(event) => setQuotaField('tokenLimit', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <div className="md:col-span-5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-surface-500">
            <button type="button" disabled={!channel || loading} onClick={() => void load()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:hover:bg-surface-800/50 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{loading ? '새로고침 중…' : '새로고침'}</button>
            <button type="button" disabled={!channel || saving} onClick={() => void saveQuota()} className="rounded-lg border border-teal-300 bg-teal-600 px-3 py-2 text-xs font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100 dark:hover:bg-primary-500/25 dark:disabled:border-surface-800 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{saving ? '저장 중…' : '사용 한도 저장'}</button>
            {usage && <span>방문자 {usage.uniqueTenants}명 · 가장 많이 사용한 방문자 {usage.topTenant ? `${usage.topTenant.tenantKey} (${usage.topTenant.messageTurns}회)` : '없음'}</span>}
            {!channel && <span className="text-amber-700 dark:text-amber-300">에이전트를 외부 배포하면 사용량을 확인할 수 있습니다.</span>}
            {error && <span className="text-red-300">{error}</span>}
          </div>
          </div>
        </details>
      </div>}
    </div>
  );
}

function ChannelCredentialPanel({ service, channel }: { service: AIServiceSummary; channel?: ChannelSummary }) {
  const updateChannelAccess = useAIServiceStore((s) => s.updateChannelAccess);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [tenantKey, setTenantKey] = React.useState('default');
  const [userKey, setUserKey] = React.useState('visitor');
  const [exposure, setExposure] = React.useState<'auth-required' | 'unlisted' | 'public'>('unlisted');
  const [credential, setCredential] = React.useState<ChannelCredentialResponse | null>(null);
  const [status, setStatus] = React.useState<'idle'|'issuing'|'revoking'|'saving-access'>('idle');
  const [error, setError] = React.useState('');
  const [accessMode, setAccessMode] = React.useState<AIServiceChannelAccessMode>(() => channelAccessMode(channel));
  const [accessUi, setAccessUi] = React.useState<Required<AIServicePublicUiConfig>>(() => channelPublicUi(channel));
  const [accessPassword, setAccessPassword] = React.useState('');
  const [passwordCopied, setPasswordCopied] = React.useState(false);
  const [linkCopied, setLinkCopied] = React.useState(false);
  const [testQuestion, setTestQuestion] = React.useState('이 AI가 답할 수 있는 내용과 근거를 간단히 알려줘.');
  const [testStatus, setTestStatus] = React.useState<'idle'|'running'>('idle');
  const [testAnswer, setTestAnswer] = React.useState('');
  const [testError, setTestError] = React.useState('');
  React.useEffect(() => { setAccessMode(channelAccessMode(channel)); setAccessUi(channelPublicUi(channel)); setAccessPassword(''); }, [channel?.id, channel?.accessMode, channel?.publicUi]);
  const canIssue = service.status === 'active' && channel?.status === 'enabled' && accessMode !== 'disabled';
  const createPassword = async () => { const next = makeSharePassword(); setAccessMode('password'); setAccessPassword(next); setPasswordCopied(false); await copyText(next); setPasswordCopied(true); };
  const publicWebsiteUrl = channel ? `${window.location.origin}/ai/${encodeURIComponent(channel.id)}` : '';
  const hostedChatUrl = credential?.serving?.chatUrlTemplate?.replace('<token>', encodeURIComponent(credential.token)) || publicWebsiteUrl;
  const copyPublicLink = async () => { await copyText(publicWebsiteUrl); setLinkCopied(true); window.setTimeout(() => setLinkCopied(false), 1800); };
  const sharePublicLink = async () => {
    if (!publicWebsiteUrl) return;
    if (navigator.share) {
      try { await navigator.share({ title: service.name, text: `${service.name} AI 에이전트`, url: publicWebsiteUrl }); return; }
      catch (err) { if (err instanceof DOMException && err.name === 'AbortError') return; }
    }
    await copyPublicLink();
  };
  const testCurrentDeployment = async () => {
    if (!channel || !testQuestion.trim() || !canIssue) return;
    setTestStatus('running'); setTestAnswer(''); setTestError('');
    try {
      const created = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/preview/conversations`, { method: 'POST', headers: authJsonHeaders(), body: JSON.stringify({ channelId: channel.id }) });
      const conversation = await created.json().catch(() => ({}));
      if (!created.ok || !conversation.id) throw new Error(conversation.error || `테스트 대화 생성 HTTP ${created.status}`);
      const response = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/preview/conversations/${encodeURIComponent(conversation.id)}/messages`, { method: 'POST', headers: authJsonHeaders(), body: JSON.stringify({ channelId: channel.id, message: testQuestion.trim() }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `테스트 질문 HTTP ${response.status}`);
      const answer = previewAnswerText(body);
      if (!answer.trim()) throw new Error('테스트는 끝났지만 답변이 비어 있습니다. 배포하지 말고 Runtime 상태를 확인해 주세요.');
      setTestAnswer(answer);
    } catch (err) { setTestError(err instanceof Error ? err.message : '테스트 질문에 답하지 못했습니다.'); }
    finally { setTestStatus('idle'); }
  };
  const issue = async () => {
    if (!channel || !tenantKey.trim() || !userKey.trim()) return;
    setStatus('issuing'); setError('');
    try {
      const res = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/channels/${encodeURIComponent(channel.id)}/credentials`, { method: 'POST', headers: authJsonHeaders(), body: JSON.stringify({ tenantKey: tenantKey.trim(), userKey: userKey.trim(), exposure, ttlSeconds: 3600 }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setCredential(body);
    } catch (err) { setError(err instanceof Error ? err.message : '배포 웹사이트 링크를 만들지 못했습니다.'); }
    finally { setStatus('idle'); }
  };
  const saveAccess = async () => {
    if (!channel) return;
    setStatus('saving-access'); setError('');
    try {
      await updateChannelAccess(service.id, channel.id, { mode: accessMode, password: accessMode === 'password' ? accessPassword : undefined, ui: accessUi });
      setAccessPassword('');
    } catch (err) { setError(err instanceof Error ? err.message : '공개 범위를 저장하지 못했습니다.'); }
    finally { setStatus('idle'); }
  };
  const revoke = async () => {
    if (!channel || !credential?.token) return;
    setStatus('revoking'); setError('');
    try {
      const res = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/channels/${encodeURIComponent(channel.id)}/credentials/revoke`, { method: 'POST', headers: authJsonHeaders(), body: JSON.stringify({ token: credential.token, reason: 'ui-revoke' }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setCredential(null);
    } catch (err) { setError(err instanceof Error ? err.message : '배포 링크를 회수하지 못했습니다.'); }
    finally { setStatus('idle'); }
  };
  return (
    <div className="mt-4 rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm dark:border-emerald-500/20 dark:bg-surface-950/35">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-bold text-slate-950 dark:text-surface-100">외부 접속 링크</div>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-surface-500">외부 배포된 에이전트를 사용자가 바로 열 수 있는 채팅 웹사이트 링크로 제공합니다. API와 token 세부값은 고급 설정에 숨겼습니다.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <button type="button" disabled={!canIssue} onClick={() => void sharePublicLink()} className="rounded-xl border border-emerald-300 bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-emerald-500 disabled:border-emerald-200 disabled:bg-emerald-100 disabled:text-emerald-500 disabled:shadow-none dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-100 dark:hover:bg-emerald-500/25 dark:disabled:border-emerald-900 dark:disabled:bg-emerald-950 dark:disabled:text-emerald-700">공유하기</button>
          <button type="button" disabled={!canIssue} onClick={() => void copyPublicLink()} className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-200 dark:hover:bg-surface-800/50 dark:disabled:border-surface-800 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{linkCopied ? '복사됨' : '링크 복사'}</button>
          <button type="button" disabled={!canIssue} onClick={() => window.open(publicWebsiteUrl, '_blank', 'noopener,noreferrer')} className="col-span-2 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-200 dark:hover:bg-surface-800/50 dark:disabled:border-surface-800 dark:disabled:bg-surface-900 dark:disabled:text-surface-600 sm:col-span-1">에이전트 열기</button>
          {credential && <button type="button" disabled={status !== 'idle'} onClick={() => void revoke()} className="rounded-xl border border-red-200 bg-white px-3 py-2.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-500/25 dark:bg-transparent dark:text-red-200">고급 링크 회수</button>}
        </div>
      </div>
      <div className="mt-4 grid gap-3 rounded-xl border border-emerald-200 bg-white/80 p-3 dark:border-surface-800 dark:bg-surface-950/60 md:grid-cols-[220px_minmax(0,1fr)_auto] md:items-end">
        <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">공개 방식<select value={accessMode} onChange={(event) => setAccessMode(event.target.value as AIServiceChannelAccessMode)} disabled={!channel || status !== 'idle'} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-semibold text-slate-900 outline-none focus:border-teal-500 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500 dark:disabled:bg-surface-900 dark:disabled:text-surface-600"><option value="unlisted">링크 공유 · 링크를 아는 사람만</option><option value="password">비밀번호 보호 · 비밀번호를 아는 사람만</option><option value="disabled">일시 중지 · 아무도 접속 못함</option><option value="login_required">로그인 필요 · 준비 중</option><option value="public">완전 공개 · 누구나 접속</option></select></label>
        <label className={`text-[11px] font-semibold ${accessMode === 'password' ? 'text-slate-700 dark:text-surface-400' : 'text-slate-400 dark:text-surface-700'}`}>공유 비밀번호<input value={accessPassword} onChange={(event) => { setAccessPassword(event.target.value); setPasswordCopied(false); }} disabled={!channel || accessMode !== 'password' || status !== 'idle'} type="text" placeholder={channel?.hasPassword ? '기존 비밀번호 유지 · 새 비밀번호를 입력하면 변경' : '비밀번호 입력 또는 자동 생성'} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-500 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:placeholder:text-surface-600 dark:focus:border-primary-500 dark:disabled:bg-surface-900 dark:disabled:text-surface-600" /></label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!channel || status !== 'idle'} onClick={() => void createPassword()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:hover:bg-surface-800/50 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{passwordCopied ? '생성·복사됨' : '비밀번호 만들기'}</button>
          <button type="button" disabled={!channel || status !== 'idle' || (accessMode === 'password' && !channel?.hasPassword && !accessPassword.trim())} onClick={() => void saveAccess()} className="rounded-lg border border-teal-300 bg-teal-600 px-3 py-2 text-xs font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100 dark:hover:bg-primary-500/25 dark:disabled:border-surface-800 dark:disabled:bg-surface-900 dark:disabled:text-surface-600">{status === 'saving-access' ? '저장 중…' : '저장'}</button>
        </div>
        <div className="md:col-span-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-surface-800 dark:bg-surface-900/35 sm:grid-cols-4">
          {[
            ['showInfoPanel', '정보 패널 표시'], ['showTools', '도구 표시'], ['showMaterials', '공개 자료 표시'], ['showTiming', '응답 시간 표시'],
          ].map(([key, label]) => <label key={key} className="flex items-center gap-2 text-[11px] font-semibold text-slate-700 dark:text-surface-400"><input type="checkbox" checked={Boolean(accessUi[key as keyof typeof accessUi])} onChange={(event) => setAccessUi((current) => ({ ...current, [key]: event.target.checked }))} disabled={!channel || status !== 'idle'} className="h-3.5 w-3.5 rounded border-slate-300 accent-teal-600 disabled:opacity-45 dark:border-surface-700 dark:bg-surface-950 dark:accent-primary-500" />{label}</label>)}
        </div>
        <p className="md:col-span-3 text-[11px] leading-5 text-slate-500 dark:text-surface-600">어렵다면 기본은 “링크 공유”입니다. 비밀번호는 저장 후 다시 볼 수 없으니, 새로 만들면 바로 복사해 공유하세요. 나중에 언제든 새 비밀번호로 바꿀 수 있습니다.</p>
      </div>
      {!canIssue && <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">아직 외부 배포되지 않았거나 외부 접속이 일시 중지되어 있습니다. 먼저 아래의 외부 배포 버튼을 누르면 링크가 생깁니다.</div>}
      {error && <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200">{error}</div>}
      {canIssue && <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-900/35" aria-label="현재 배포 테스트"><div className="text-xs font-bold text-slate-800 dark:text-surface-200">현재 고객 답변 확인</div><p className="mt-1 text-[11px] leading-5 text-slate-500 dark:text-surface-500">공유 전에 운영 중인 현재 버전에 질문해 답변이 비어 있거나 실패하지 않는지 확인하세요.</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><input value={testQuestion} onChange={(event) => setTestQuestion(event.target.value)} disabled={testStatus === 'running'} className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" aria-label="테스트 질문" /><button type="button" disabled={!testQuestion.trim() || testStatus === 'running'} onClick={() => void testCurrentDeployment()} className="rounded-lg border border-teal-300 bg-white px-4 py-2.5 text-sm font-bold text-teal-800 disabled:opacity-50 dark:border-primary-500/35 dark:bg-transparent dark:text-primary-200">{testStatus === 'running' ? '답변 확인 중…' : '테스트 질문 보내기'}</button></div>{testAnswer && <div className="mt-3 rounded-lg border border-emerald-200 bg-white p-3 text-sm leading-6 text-slate-800 dark:border-emerald-500/20 dark:bg-surface-950 dark:text-surface-200"><div className="mb-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">정상 답변</div>{testAnswer}</div>}{testError && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200"><div className="mb-1 text-[11px] font-bold">테스트 실패 · 공유 전에 확인 필요</div>{testError}</div>}</section>}
      {canIssue ? <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-3 shadow-sm dark:border-surface-800 dark:bg-surface-950/70">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-emerald-700 dark:text-emerald-200">공유 링크</span><span className="text-[11px] text-slate-500 dark:text-surface-600">외부 배포됨 · 자동 생성</span></div>
        <button type="button" onClick={() => void copyPublicLink()} className="mt-2 block w-full break-all rounded-lg bg-emerald-50 px-3 py-3 text-left text-xs text-emerald-800 dark:bg-surface-900 dark:text-emerald-200" aria-label="공유 링크를 클립보드에 복사">{publicWebsiteUrl}</button>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <button type="button" onClick={() => void sharePublicLink()} className="rounded-lg border border-primary-300 bg-primary-50 px-3 py-3 text-sm font-bold text-primary-800 dark:border-primary-400/35 dark:bg-transparent dark:text-primary-200">공유하기</button>
          <button type="button" onClick={() => void copyPublicLink()} className="rounded-lg border border-slate-200 px-3 py-3 text-sm font-bold text-slate-700 dark:border-surface-700 dark:text-surface-300">{linkCopied ? '복사됨' : '링크 복사'}</button>
          <button type="button" onClick={() => window.open(publicWebsiteUrl, '_blank', 'noopener,noreferrer')} className="col-span-2 rounded-lg border border-slate-200 px-3 py-3 text-sm font-semibold text-slate-700 dark:border-surface-700 dark:text-surface-300 sm:col-span-1">에이전트 열기</button>
        </div>
      </div> : <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white/70 p-4 text-sm text-slate-500 dark:border-surface-700 dark:bg-surface-950/35 dark:text-surface-500">아직 외부 배포된 에이전트가 없습니다. 아래의 외부 배포 버튼을 누르면 웹사이트 URL이 자동으로 생깁니다.</div>}
      <button type="button" onClick={() => setAdvancedOpen((value) => !value)} className="mt-3 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-surface-500 dark:hover:text-surface-300">{advancedOpen ? '고급 설정 닫기' : '고급 설정 · API/token 보기'}</button>
      {advancedOpen && <div className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-950/45 md:grid-cols-3">
        <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">Tenant key<input value={tenantKey} onChange={(event) => setTenantKey(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
        <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">User key<input value={userKey} onChange={(event) => setUserKey(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
        <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">Exposure<select value={exposure} onChange={(event) => setExposure(event.target.value as typeof exposure)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500"><option value="auth-required">auth-required</option><option value="unlisted">unlisted</option><option value="public">public</option></select></label>
        <div className="md:col-span-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={!canIssue || status !== 'idle'} onClick={() => void issue()} className="rounded-lg border border-teal-300 bg-white px-3 py-2 text-xs font-semibold text-teal-800 hover:bg-teal-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-transparent dark:text-primary-200 dark:disabled:opacity-40">{status === 'issuing' ? '고급 링크 발급 중…' : '고급 credential 링크 발급'}</button>
        </div>
        {credential && <div className="md:col-span-3 grid gap-2 text-[11px]">
          <div className="grid gap-1"><span className="text-slate-500 dark:text-surface-600">Credential Chat URL</span><code className="break-all rounded bg-white px-2 py-1 text-emerald-800 ring-1 ring-slate-200 dark:bg-surface-900 dark:text-emerald-200 dark:ring-0">{hostedChatUrl}</code></div>
          <div className="grid gap-1"><span className="text-slate-500 dark:text-surface-600">Conversation API URL</span><code className="break-all rounded bg-white px-2 py-1 text-teal-800 ring-1 ring-slate-200 dark:bg-surface-900 dark:text-primary-200 dark:ring-0">{credential.serving?.conversationUrl}</code><button type="button" onClick={() => void copyText(credential.serving?.conversationUrl || '')} className="justify-self-start text-teal-700 dark:text-primary-300">API URL 복사</button></div>
          <div className="grid gap-1"><span className="text-slate-500 dark:text-surface-600">Message API URL template</span><code className="break-all rounded bg-white px-2 py-1 text-teal-800 ring-1 ring-slate-200 dark:bg-surface-900 dark:text-primary-200 dark:ring-0">{credential.serving?.messageUrlTemplate}</code></div>
          <div className="grid gap-1"><span className="text-slate-500 dark:text-surface-600">Bearer token · 한 번만 표시하고 외부 공유를 주의하세요</span><textarea readOnly value={credential.token} className="min-h-20 rounded border border-slate-200 bg-white p-2 font-mono text-[10px] text-slate-700 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-300" /><button type="button" onClick={() => void copyText(credential.token)} className="justify-self-start text-teal-700 dark:text-primary-300">Token 복사</button></div>
        </div>}
      </div>}
    </div>
  );
}

function ConversationHistoryPanel({ service }: { service: AIServiceSummary }) {
  const getConversations = useAIServiceStore((s) => s.getConversations);
  const [conversations, setConversations] = React.useState<AIServiceConversationSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    void getConversations(service.id).then((items) => { if (live) setConversations(items); }).catch((err) => { if (live) setError(err instanceof Error ? err.message : '과거 대화를 불러오지 못했습니다.'); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [getConversations, service.id, service.metrics?.conversations]);
  return <section className="border-t border-slate-200 py-5 dark:border-surface-800" aria-labelledby={`conversation-history-${service.id}`}>
    <div className="flex items-end justify-between gap-3"><div><h4 id={`conversation-history-${service.id}`} className="text-sm font-bold text-slate-900 dark:text-surface-100">과거 대화</h4><p className="mt-1 text-xs text-slate-500 dark:text-surface-500">외부 사용자의 대화는 Tower의 배포 세션으로 저장됩니다.</p></div><span className="text-xs font-semibold text-slate-500 dark:text-surface-500">{conversations.length}개</span></div>
    {loading ? <div className="py-6 text-sm text-slate-500">대화를 불러오는 중…</div> : error ? <div className="py-6 text-sm text-red-600 dark:text-red-300">{error}</div> : conversations.length === 0 ? <div className="py-6 text-sm text-slate-500">아직 저장된 외부 대화가 없습니다.</div> : <div className="mt-3 divide-y divide-slate-200 border-y border-slate-200 dark:divide-surface-800 dark:border-surface-800">
      {conversations.map((conversation) => <div key={conversation.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
        <div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-800 dark:text-surface-200">{conversation.sessionName || `외부 대화 ${conversation.id.slice(0, 8)}`}</div><div className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">{new Date(conversation.updatedAt).toLocaleString('ko-KR')} · 메시지 {conversation.messageCount}개</div></div>
        <div className="text-xs text-slate-600 dark:text-surface-400">{Number(conversation.totalTokens || 0).toLocaleString()} tokens</div>
        {conversation.runtimeSessionId ? <button type="button" onClick={() => { window.location.href = `/s/${encodeURIComponent(conversation.runtimeSessionId!)}`; }} className="justify-self-start text-xs font-bold text-teal-700 hover:text-teal-600 dark:text-primary-300">세션 열기</button> : <span className="text-xs text-slate-400">세션 준비 중</span>}
      </div>)}
    </div>}
  </section>;
}

function baseAgentProject(service: AIServiceSummary): Project {
  const displayName = service.ownerAgentName || '원본 팀원 확인 불가';
  // Older/partial overview payloads may omit ownerProjectId. Avatar fallback
  // hashing requires a string, so keep rendering with the stable service id.
  const projectId = typeof service.ownerProjectId === 'string' && service.ownerProjectId ? service.ownerProjectId : service.id;
  return {
    id: projectId,
    name: displayName,
    description: null,
    rootPath: null,
    color: '#64748b',
    sortOrder: 0,
    collapsed: 0,
    archived: 0,
    createdAt: '',
    spaceId: null,
    agent: {
      id: `project:${projectId}`,
      kind: 'primary',
      projectId,
      displayName,
      face: service.ownerAgentFace || '✨',
      tagline: null,
      role: null,
      promise: null,
      profileVersion: 0,
      instructionSource: 'ai-service-overview',
      defaultEngine: null,
      defaultModel: null,
      authorityPolicy: {},
      toolPolicy: {},
      memoryPolicy: {},
      budgetPolicy: {},
      status: 'active',
      onboardingState: 'ready',
      explicit: true,
    },
  };
}

function ServiceListItem({ service, selected, onSelect }: { service: AIServiceSummary; selected: boolean; onSelect: () => void }) {
  const channel = service.channels?.find((item) => item.status === 'enabled') || service.channels?.[0];
  const baseProject = baseAgentProject(service);
  const operationalState = operationalFilter(service);
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={`w-full border-b border-slate-200 px-4 py-4 text-left transition-colors last:border-b-0 dark:border-surface-800 ${selected ? 'bg-teal-50 dark:bg-primary-500/10' : 'hover:bg-slate-50 dark:hover:bg-surface-800/45'}`}>
    <div className="flex items-start gap-3">
      <AgentIdentityAvatar project={baseProject} variant="list" showListAccent={false} className="h-10 w-10 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-bold text-slate-950 dark:text-surface-100">{service.name}</div><div className="mt-1 truncate text-xs text-slate-500 dark:text-surface-500">베이스 · {service.ownerAgentName || 'Primary AI 팀원'}</div></div>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${operationalState === 'active' ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200' : operationalState === 'paused' ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200' : tone(service.status)}`}>{operationalState === 'active' ? '운영 중' : operationalState === 'paused' ? '접근 중지' : label(service.status)}</span>
    </div>
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 pl-[52px] text-[11px] text-slate-500 dark:text-surface-600"><span>v{service.currentDeployment?.version || 0}</span><span>대화 {service.metrics?.conversations || 0}</span><span>{channelAccessMode(channel) === 'disabled' ? '접근 중지' : channelAccessMode(channel) === 'password' ? '비밀번호 보호' : channelAccessMode(channel) === 'public' ? '완전 공개' : '링크 공유'}</span></div>
  </button>;
}

function ServiceRow({ service }: { service: AIServiceSummary }) {
  const confirm = useConfirm();
  const retire = useAIServiceStore((s) => s.retire);
  const updateService = useAIServiceStore((s) => s.updateService);
  const updateChannelAccess = useAIServiceStore((s) => s.updateChannelAccess);
  const mutating = useAIServiceStore((s) => s.mutatingId === service.id);
  const [editOpen, setEditOpen] = React.useState(false);
  const [editName, setEditName] = React.useState(service.name);
  const [editDescription, setEditDescription] = React.useState(service.description || '');
  React.useEffect(() => { setEditName(service.name); setEditDescription(service.description || ''); }, [service.name, service.description]);
  const channel = service.channels?.find((item) => item.status === 'enabled') || service.channels?.[0];
  const knowledgeRefs = deploymentKnowledgeRefs(service);
  const operationalState = operationalFilter(service);
  const saveEdit = async () => { if (!editName.trim()) return; await updateService(service.id, { name: editName.trim(), description: editDescription }); setEditOpen(false); };
  const makePrivate = async () => {
    if (!channel) return;
    const ok = await confirm({ title: '외부 접근 중지', message: '기존 외부 링크 접속은 즉시 차단되지만 설정과 과거 대화는 보존됩니다.', confirmLabel: '외부 접근 중지' });
    if (!ok) return;
    await updateChannelAccess(service.id, channel.id, { mode: 'disabled' });
  };
  const resumeExternalAccess = async () => {
    if (!channel) return;
    await updateChannelAccess(service.id, channel.id, { mode: 'unlisted' });
  };
  const deleteService = async () => {
    const ok = await confirm({ title: '외부 배포 에이전트 삭제', message: '외부 링크와 설정은 목록에서 제거되며, 기존 배포 세션과 대화 기록은 보존됩니다.', confirmLabel: '삭제', danger: true });
    if (!ok) return;
    await retire(service.id);
  };
  return (
    <article className="grid min-w-0 grid-cols-1 gap-4 border-t border-slate-200 px-4 py-5 first:border-t-0 dark:border-surface-800 sm:px-5" lang="ko">
      <div className="min-w-0">
        <div className="flex items-start gap-3">
          <AgentIdentityAvatar project={baseAgentProject(service)} variant="list" showListAccent={false} className="h-12 w-12 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-bold text-slate-950 dark:text-surface-100 [word-break:keep-all]">{service.name}</h3><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${operationalState === 'active' ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200' : operationalState === 'paused' ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200' : tone(service.status)}`}>{operationalState === 'active' ? '운영 중' : operationalState === 'paused' ? '접근 중지' : label(service.status)}</span></div><p className="mt-1 text-xs font-semibold text-slate-500 dark:text-surface-500">베이스 팀원 · {service.ownerAgentName || 'Primary AI 팀원'}</p></div>
        </div>
        <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600 dark:text-surface-500 [word-break:keep-all]">{service.description || '서비스 설명이 없습니다.'}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-surface-600">
          <span>현재 배포 · {service.currentDeployment ? `v${service.currentDeployment.version}` : '없음'}</span>
          <span>배포일 · {shortDate(service.currentDeployment?.deployedAt || service.currentDeployment?.createdAt)}</span>
          <span>외부 접근 · {operationalState === 'active' ? '사용 가능' : operationalState === 'paused' ? '중지됨' : '준비 중'}</span>
          <span>Knowledge · {knowledgeRefs.length ? `${knowledgeRefs.length}개 문헌` : '연결 없음'}</span>
        </div>
        <div className="mt-4 grid gap-4 border-y border-slate-200 py-4 text-xs dark:border-surface-800 md:grid-cols-[1fr_1fr_1.2fr]">
          <div><div className="text-[11px] font-semibold text-slate-500 dark:text-surface-600">실행 구성</div><div className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{service.currentDeployment?.policySnapshot?.harnessBinding?.harnessId || 'Harness 없음'}{service.currentDeployment?.policySnapshot?.harnessBinding?.harnessVersion ? ` @v${service.currentDeployment.policySnapshot.harnessBinding.harnessVersion}` : ''}</div><div className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">{service.currentDeployment?.policySnapshot?.harnessBinding?.model || 'Harness 기본 모델'}</div></div>
          <div><div className="text-[11px] font-semibold text-slate-500 dark:text-surface-600">현재 버전</div><div className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{service.currentDeployment ? `배포 v${service.currentDeployment.version}` : '아직 없음'}</div><div className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">{shortDate(service.currentDeployment?.deployedAt || service.currentDeployment?.createdAt)}</div></div>
          <div><div className="flex items-center justify-between gap-2"><div className="text-[11px] font-semibold text-slate-500 dark:text-surface-600">고정된 Knowledge</div><span className="text-[10px] font-bold text-teal-700 dark:text-primary-300">{knowledgeRefs.length}개</span></div>{knowledgeRefs.length ? <ul className="mt-1 space-y-1">{knowledgeRefs.slice(0, 3).map((ref) => <li key={ref.path} className="truncate font-mono text-[11px] text-slate-700 dark:text-surface-300">{ref.path}</li>)}</ul> : <div className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">이 버전에는 고정된 문헌이 없습니다.</div>}{knowledgeRefs.length > 3 && <div className="mt-1 text-[10px] text-slate-500 dark:text-surface-600">외 {knowledgeRefs.length - 3}개</div>}</div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 font-semibold text-slate-600 dark:border-surface-700 dark:bg-surface-950/70 dark:text-surface-300">{exposureLabel(service, channel)}</span>
          <span className="text-slate-500 dark:text-surface-600">외부 배포, 직접 테스트, 공유, 사용 현황을 이 화면에서 관리합니다.</span>
        </div>
      </div>
      <dl className="grid max-w-md grid-cols-3 gap-3 text-left">
        <div><dt className="text-[11px] text-slate-500 dark:text-surface-600">대화</dt><dd className="mt-1 font-bold text-slate-900 dark:text-surface-200">{service.metrics?.conversations || 0}</dd></div>
        <div><dt className="text-[11px] text-slate-500 dark:text-surface-600">미해결</dt><dd className="mt-1 font-bold text-amber-600 dark:text-amber-300">{service.metrics?.unresolved || 0}</dd></div>
        <div><dt className="text-[11px] text-slate-500 dark:text-surface-600">비용</dt><dd className="mt-1 font-bold text-slate-900 dark:text-surface-200">${(service.metrics?.cost || 0).toFixed(2)}</dd></div>
      </dl>
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-surface-800 dark:bg-surface-950/35">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><div className="text-xs font-bold text-slate-800 dark:text-surface-200">관리 옵션</div><p className="mt-1 text-[11px] text-slate-500 dark:text-surface-600">외부 접근 중지는 기존 링크의 접속만 차단하고, 에이전트 삭제는 배포 목록과 설정을 제거합니다. 과거 배포 세션은 보존됩니다.</p></div>
          <div className="flex flex-wrap gap-2">
            <button disabled={mutating} onClick={() => setEditOpen((value) => !value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:hover:bg-surface-800/50">{editOpen ? '수정 닫기' : '수정'}</button>
            {channelAccessMode(channel) === 'disabled'
              ? <button disabled={mutating || !channel} onClick={() => void resumeExternalAccess()} className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-transparent dark:text-emerald-200">외부 접근 재개</button>
              : <button disabled={mutating || !channel} onClick={() => void makePrivate()} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/30 dark:bg-transparent dark:text-amber-200">외부 접근 중지</button>}
            <button disabled={mutating} onClick={() => void deleteService()} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/25 dark:bg-transparent dark:text-red-200">에이전트 삭제</button>
          </div>
        </div>
        {editOpen && <div className="mt-3 grid gap-2 md:grid-cols-[240px_minmax(0,1fr)_auto] md:items-end">
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">이름<input value={editName} onChange={(event) => setEditName(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <label className="text-[11px] font-semibold text-slate-700 dark:text-surface-400">설명<input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" /></label>
          <button disabled={mutating || !editName.trim()} onClick={() => void saveEdit()} className="rounded-lg border border-teal-300 bg-teal-600 px-3 py-2 text-xs font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100">저장</button>
        </div>}
      </div>
      <section className="min-w-0 rounded-3xl border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-500/20 dark:bg-emerald-500/5" aria-label="외부 배포와 테스트">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-black text-emerald-950 dark:text-emerald-100">외부 배포 · 테스트</div>
            <p className="mt-1 text-xs leading-5 text-emerald-800/75 dark:text-emerald-200/75">버튼 하나로 에이전트를 외부 배포하고, 바로 열어 테스트한 뒤 링크를 공유하세요.</p>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${isExternallyAccessible(service, channel) ? 'border-emerald-300 bg-white text-emerald-800 dark:border-emerald-500/25 dark:bg-surface-950/50 dark:text-emerald-200' : channelAccessMode(channel) === 'disabled' ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/8 dark:text-amber-200' : 'border-slate-300 bg-white text-slate-700 dark:border-surface-700 dark:bg-surface-950/50 dark:text-surface-300'}`}>{isExternallyAccessible(service, channel) ? '운영 중' : channelAccessMode(channel) === 'disabled' ? '접근 중지' : service.status === 'paused' ? '일시 중지' : '배포 전'}</span>
        </div>
        <DeploymentFlowPanel service={service} channel={channel} />
        <DeploymentVersionPanel service={service} />
        {service.status === 'active' && <>
          <ChannelCredentialPanel service={service} channel={channel} />
          <ChannelUsagePanel service={service} channel={channel} />
        </>}
      </section>
      <div className="min-w-0"><ConversationHistoryPanel service={service} /></div>
    </article>
  );
}

function HarnessChoice({ mode, harnesses, selectedId, onSelect, onOpenDraft }: { mode: CreateMode; harnesses: PublishedHarness[]; selectedId: string; onSelect: (id: string) => void; onOpenDraft: () => void }) {
  return (
    <div className="mt-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900 dark:text-surface-200">실행 도구 체계</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-surface-500 [word-break:keep-all]">발행된 Harness를 쓰거나, 필요한 Tool이 없다면 새 Harness draft로 전환합니다.</p>
        </div>
        <span className="rounded-md border border-slate-200 px-2 py-1 font-mono text-[10px] text-slate-500 dark:border-surface-700 dark:text-surface-500">Harness</span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {harnesses.map((item) => { const effective = effectiveHarness(item); const selected = mode === 'published' && selectedId === item.id; return <button key={item.id} type="button" onClick={() => onSelect(item.id)} aria-pressed={selected} className={`rounded-xl border p-3 text-left transition-colors ${selected ? 'border-emerald-400 bg-emerald-50 dark:border-emerald-500/45 dark:bg-emerald-500/8' : 'border-slate-200 bg-white hover:border-slate-300 dark:border-surface-700 dark:bg-surface-950/55 dark:hover:border-surface-600'}`}>
          <div className="flex items-center justify-between gap-2"><span className="text-sm font-bold text-slate-900 dark:text-surface-100">{item.name}</span><span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">발행됨</span></div>
          <p className="mt-1 font-mono text-[10px] text-slate-500 dark:text-surface-500">{item.id}@v{item.current_version} · {effective.runtimeProfileId}@v{effective.runtimeProfileVersion}</p>
          <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-surface-400">Pi · {effective.defaultModel || '기본 모델'} · capability {effective.capabilityIds.length}개</p>
        </button>; })}
        <button type="button" onClick={onOpenDraft} aria-pressed={mode === 'custom-draft'} className={`rounded-xl border p-3 text-left transition-colors ${mode === 'custom-draft' ? 'border-amber-400 bg-amber-50 dark:border-amber-500/45 dark:bg-amber-500/8' : 'border-slate-200 bg-white hover:border-slate-300 dark:border-surface-700 dark:bg-surface-950/55 dark:hover:border-surface-600'}`}>
          <div className="flex items-center justify-between gap-2"><span className="text-sm font-bold text-slate-900 dark:text-surface-100">새 실행 도구 체계</span><span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">Harness draft</span></div>
          <p className="mt-1 text-[10px] text-slate-500 dark:text-surface-500">서버에 draft를 저장하고 검증 후 새 version으로 발행</p>
          <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-surface-400">현재는 WebSearch·WebFetch capability 조합을 지원</p>
        </button>
      </div>

      {mode === 'published' && (() => { const item = harnesses.find((candidate) => candidate.id === selectedId); const effective = item ? effectiveHarness(item) : null; return <div className="mt-3 border-y border-slate-200 py-3 dark:border-surface-800">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-800 dark:text-surface-300">현재 capability</span><span className="text-[10px] text-slate-500 dark:text-surface-600">{effective?.capabilityIds.length || 0}개 제공 · Registry 발행본</span></div>
        <div className="mt-2 divide-y divide-slate-200 dark:divide-surface-800">
          {(effective?.capabilityIds || []).map((id) => { const capability = CAPABILITY_COPY[id] || { tool: id, label: id, detail: '발행된 Harness capability' }; return <div key={id} className="flex items-start justify-between gap-3 py-2.5">
            <div><div className="text-xs font-semibold text-slate-800 dark:text-surface-200">{capability.label}</div><p className="mt-0.5 text-[11px] leading-5 text-slate-500 dark:text-surface-500">{capability.detail}</p></div>
            <div className="shrink-0 text-right"><div className="font-mono text-[10px] text-teal-700 dark:text-primary-300">{id}</div><div className="mt-1 font-mono text-[10px] text-slate-500 dark:text-surface-600">{capability.tool}</div></div>
          </div>; })}
        </div>
        <button type="button" onClick={onOpenDraft} className="mt-2 text-xs font-semibold text-amber-300 hover:text-amber-200">이 Harness에서 새 draft 만들기 →</button>
      </div>; })()}

      {mode === 'custom-draft' && <div className="mt-3 border-y border-amber-500/25 bg-amber-500/5 px-1 py-3">
        <div className="text-xs font-bold text-amber-800 dark:text-amber-200">미발행 실행 도구 체계</div>
        <p className="mt-1 text-[11px] leading-5 text-amber-900/70 dark:text-surface-400 [word-break:keep-all]">Harness Builder에서 검증·발행한 뒤 이 서비스 초안으로 돌아와야 합니다. 지금은 외부 활성화할 수 없습니다.</p>
      </div>}
    </div>
  );
}

function HarnessDraftHandoff({ projectId, baseHarness, onClose, onPublished }: { projectId: string; baseHarness?: PublishedHarness; onClose: () => void; onPublished: (item: PublishedHarness) => void }) {
  const [name, setName] = React.useState('customer-support-web');
  const [visibility, setVisibility] = React.useState<'project' | 'private'>('project');
  const [status, setStatus] = React.useState<'idle'|'creating'|'validating'|'publishing'>('idle');
  const [error, setError] = React.useState('');
  const publish = async () => {
    if (!projectId || !name.trim()) return;
    setError(''); setStatus('creating');
    const token = localStorage.getItem('token');
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    try {
      const profileId = `${harnessSlug(name)}-web`;
      const manifest = { schemaVersion: 2, engine: 'pi', runtimeProfile: { id: profileId, version: 1 }, defaultModel: 'litellm-responses/smart', allowedModels: ['litellm-responses/smart'], prompt: { includeAgentIdentity: true, includeProjectInstructions: false, includeMemory: false, includeSkills: false, components: [] }, capabilityIds: ['web.fetch','web.search'] };
      const draftRes = await fetch('/api/harnesses/drafts', { method: 'POST', headers, body: JSON.stringify({ name: name.trim(), ownerProjectId: projectId, visibility, baseHarnessId: baseHarness?.id, baseHarnessVersion: baseHarness?.current_version, manifest }) });
      const draft = await draftRes.json().catch(() => ({})); if (!draftRes.ok) throw new Error(draft.error || `Draft HTTP ${draftRes.status}`);
      setStatus('validating');
      const validationRes = await fetch(`/api/harnesses/drafts/${encodeURIComponent(draft.id)}/validate`, { method: 'POST', headers });
      const validation = await validationRes.json().catch(() => ({})); if (!validationRes.ok || validation.status !== 'valid') throw new Error(validation.error || validation.errors?.join(', ') || 'Harness 검증 실패');
      setStatus('publishing');
      const id = harnessSlug(name); if (!id) throw new Error('영문 또는 숫자가 포함된 Harness 이름이 필요합니다.');
      const publishRes = await fetch(`/api/harnesses/drafts/${encodeURIComponent(draft.id)}/publish`, { method: 'POST', headers, body: JSON.stringify({ validationRunId: validation.id, expectedRevision: draft.revision, harnessId: id }) });
      const published = await publishRes.json().catch(() => ({})); if (!publishRes.ok) throw new Error(published.error || `Publish HTTP ${publishRes.status}`);
      onPublished({ id: published.harnessId, name: name.trim(), current_version: published.version, effective_manifest: { id: published.harnessId, version: published.version, runtimeProfileId: published.runtimeProfileId, runtimeProfileVersion: published.runtimeProfileVersion, engine: 'pi', defaultModel: 'litellm-responses/smart', capabilityIds: ['web.fetch','web.search'] } });
    } catch (err) { setError(err instanceof Error ? err.message : 'Harness를 발행하지 못했습니다.'); setStatus('idle'); }
  };
  return (
    <div className="absolute inset-0 z-10 flex items-end bg-slate-950/45 p-4 backdrop-blur-sm dark:bg-surface-950/90 sm:items-center sm:justify-center" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="harness-draft-title" className="w-full rounded-xl border border-slate-200 bg-white p-4 text-slate-950 shadow-2xl dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100 sm:max-w-md">
        <div className="flex items-start justify-between gap-4"><div><div className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">Harness draft</div><h3 id="harness-draft-title" className="mt-1 text-lg font-bold text-slate-950 dark:text-surface-100">새 실행 도구 체계 만들기</h3></div><button type="button" onClick={onClose} aria-label="닫기" className="text-lg text-slate-400 hover:text-slate-700 dark:text-surface-500 dark:hover:text-surface-200">×</button></div>
        <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-surface-400 [word-break:keep-all]">현재 `quick-web-research@v1`에는 배송조회 MCP 같은 업무 Tool이 없습니다. 추가하면 원본을 수정하지 않고 새 Harness draft를 만듭니다.</p>
        <label className="mt-4 block text-xs font-semibold text-slate-700 dark:text-surface-300">새 Harness 이름<input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-amber-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100" /></label>
        <fieldset className="mt-4"><legend className="text-xs font-semibold text-slate-700 dark:text-surface-300">사용 범위</legend><div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setVisibility('project')} aria-pressed={visibility === 'project'} className={`rounded-lg border p-2.5 text-left text-xs ${visibility === 'project' ? 'border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-500/45 dark:bg-amber-500/8 dark:text-amber-100' : 'border-slate-200 text-slate-600 dark:border-surface-700 dark:text-surface-400'}`}>이 프로젝트</button>
          <button type="button" onClick={() => setVisibility('private')} aria-pressed={visibility === 'private'} className={`rounded-lg border p-2.5 text-left text-xs ${visibility === 'private' ? 'border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-500/45 dark:bg-amber-500/8 dark:text-amber-100' : 'border-slate-200 text-slate-600 dark:border-surface-700 dark:text-surface-400'}`}>비공개</button>
        </div></fieldset>
        <div className="mt-4 border-l-2 border-amber-500/60 pl-3 text-[11px] leading-5 text-slate-500 dark:text-surface-500">서버가 draft를 저장하고 manifest를 검증한 뒤 불변 version으로 발행합니다. 현재는 공개 웹 검색과 원문 읽기 capability 조합을 지원합니다.</div>
        {error && <p className="mt-3 text-xs leading-5 text-red-700 dark:text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} disabled={status !== 'idle'} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 dark:border-surface-700 dark:bg-transparent dark:text-surface-300 dark:disabled:opacity-40">취소</button><button type="button" disabled={!name.trim() || !projectId || status !== 'idle'} onClick={() => void publish()} className="rounded-lg border border-amber-400 bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100 dark:disabled:opacity-40">{status === 'creating' ? 'draft 저장 중…' : status === 'validating' ? '검증 중…' : status === 'publishing' ? '발행 중…' : '검증하고 발행'}</button></div>
      </section>
    </div>
  );
}

export function AIServiceHome() {
  const { services, loading, error, filter, setFilter, load } = useAIServiceStore();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  const [projects, setProjects] = React.useState<Array<{id:string;name:string;rootPath?:string;agent?:{displayName?:string}}>>([]);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState('');
  const [harnesses, setHarnesses] = React.useState<PublishedHarness[]>([]);
  const [selectedHarnessId, setSelectedHarnessId] = React.useState('quick-web-research');
  const [modelChoice, setModelChoice] = React.useState<'harness-default'|'smart'>('smart');
  const [shareMode, setShareMode] = React.useState<'unlisted'|'password'>('unlisted');
  const [sharePassword, setSharePassword] = React.useState('');
  const [knowledgePaths, setKnowledgePaths] = React.useState('');
  const [knowledgePickerOpen, setKnowledgePickerOpen] = React.useState(false);
  const [capabilityPreview, setCapabilityPreview] = React.useState({ knowledge: true, dataRead: false, propose: false, execute: false });
  const [actionApproval, setActionApproval] = React.useState<'every-time'|'policy'|'disabled'>('every-time');
  const [selectedServiceId, setSelectedServiceId] = React.useState<string | null>(null);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    if (!createOpen) return;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    void Promise.all([
      fetch('/api/projects', { headers }).then((response) => response.json()),
      fetch('/api/ai-services/harness-options', { headers }).then((response) => response.json()),
    ]).then(([projectData, harnessData]) => {
      setProjects(Array.isArray(projectData) ? projectData : Array.isArray(projectData.projects) ? projectData.projects : []);
      const next = Array.isArray(harnessData.harnesses) ? harnessData.harnesses : [];
      setHarnesses(next);
      if (next.length && !next.some((item: PublishedHarness) => item.id === selectedHarnessId)) setSelectedHarnessId(next[0].id);
    }).catch(() => { setProjects([]); setHarnesses([]); });
  }, [createOpen]);

  const closeCreate = () => {
    setCreateOpen(false);
    setCreateError('');
    setModelChoice('smart');
    setShareMode('unlisted');
    setSharePassword('');
    setKnowledgePaths('');
    setKnowledgePickerOpen(false);
    setCapabilityPreview({ knowledge: true, dataRead: false, propose: false, execute: false });
    setActionApproval('every-time');
  };

  const createService = async () => {
    if (!name.trim() || !projectId || (shareMode === 'password' && !sharePassword.trim())) return;
    const selected = harnesses.find((item) => item.id === selectedHarnessId);
    if (!selected) { setCreateError('발행된 Harness를 선택해주세요.'); return; }
    const effective = effectiveHarness(selected);
    const selectedModel = modelChoice === 'smart' ? 'litellm-responses/smart' : effective.defaultModel;
    if (!effective.runtimeProfileId || !Number.isInteger(effective.runtimeProfileVersion) || effective.runtimeProfileVersion < 1) { setCreateError('완전한 Harness runtime profile binding이 필요합니다. 다른 Harness를 선택하거나 새로고침해주세요.'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const token = localStorage.getItem('token');
      const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const selectedKnowledgePaths = [...new Set(knowledgePaths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
      const response = await fetch('/api/ai-services', { method: 'POST', headers, body: JSON.stringify({ name: name.trim(), ownerProjectId: projectId, serviceType: 'customer', description: selectedKnowledgePaths.length ? '승인된 배포 자료를 바탕으로 답변하는 제한형 AI 서비스' : '공개 웹 자료를 조사하는 제한형 AI 서비스' }) });
      const service = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(service.error || `HTTP ${response.status}`);
      const deployment = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/deployments`, {
        method: 'POST', headers, body: JSON.stringify({
          sourceSnapshot: selectedKnowledgePaths.length ? {
            kind: 'knowledge',
            version: 1,
            refs: selectedKnowledgePaths.map((path) => ({ path })),
          } : {
            kind: 'none',
            version: 1,
            refs: [],
            userFacingLabel: '연결된 배포 자료 없음',
          },
          policySnapshot: {
            harnessBinding: { harnessId: effective.id, harnessVersion: effective.version, runtimeProfileId: effective.runtimeProfileId, runtimeProfileVersion: effective.runtimeProfileVersion, engine: effective.engine, model: selectedModel, status: 'published' },
            capabilityOverrides: [],
            // Server canonicalization replaces this preview with every concrete
            // tool compiled from the selected published Harness.
            allowedTools: effective.capabilityIds.map((id) => CAPABILITY_COPY[id]?.tool || id),
            refuseWithoutEvidence: true,
            conversationIsolation: 'per-visitor',
            learningFromConversations: false,
          },
          experienceSnapshot: { greeting: selectedKnowledgePaths.length ? '안녕하세요. 승인된 배포 자료를 바탕으로 근거와 함께 답변합니다.' : '안녕하세요. 공개 웹 자료를 확인해 출처와 함께 답변합니다.' },
          evaluationSnapshot: { status: 'not_run', cases: [] },
        }),
      });
      const deploymentBody = await deployment.json().catch(() => ({}));
      if (!deployment.ok) throw new Error(deploymentBody.error || `배포 준비 HTTP ${deployment.status}`);
      const deployed = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/deploy-now`, { method: 'POST', headers, body: JSON.stringify({ deploymentId: deploymentBody.id }) });
      const deployedBody = await deployed.json().catch(() => ({}));
      if (!deployed.ok) throw new Error(deployedBody.error || `배포 HTTP ${deployed.status}`);
      const overviewResponse = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}`, { headers });
      const overview = await overviewResponse.json().catch(() => ({}));
      if (!overviewResponse.ok) throw new Error(overview.error || `웹사이트 확인 HTTP ${overviewResponse.status}`);
      const website = Array.isArray(overview.channels) ? overview.channels.find((item: {channelType?:string;id?:string}) => item.channelType === 'web_link') : null;
      if (!website?.id) throw new Error('웹사이트 링크를 만들지 못했습니다. 다시 시도해 주세요.');
      if (shareMode === 'password') {
        const access = await fetch(`/api/ai-services/${encodeURIComponent(service.id)}/channels/${encodeURIComponent(website.id)}/access`, { method: 'PUT', headers, body: JSON.stringify({ mode: 'password', password: sharePassword.trim() }) });
        const accessBody = await access.json().catch(() => ({}));
        if (!access.ok) throw new Error(accessBody.error || `공유 설정 HTTP ${access.status}`);
      }
      closeCreate();
      setName('');
      setProjectId('');
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'AI 서비스를 만들지 못했습니다.');
    } finally { setCreating(false); }
  };

  const visible = filter === 'all' ? services : services.filter((service) => operationalFilter(service) === filter);
  const selectedService = visible.find((service) => service.id === selectedServiceId) || visible[0] || null;
  React.useEffect(() => {
    if (selectedService && selectedService.id !== selectedServiceId) setSelectedServiceId(selectedService.id);
  }, [selectedService?.id, selectedServiceId]);
  const active = services.filter((service) => operationalFilter(service) === 'active').length;
  const review = services.filter((service) => operationalFilter(service) === 'review').length;
  const paused = services.filter((service) => operationalFilter(service) === 'paused').length;
  const preparing = services.filter((service) => operationalFilter(service) === 'draft').length;

  return (
    <main className="h-full overflow-auto bg-slate-50 px-4 py-5 text-slate-950 dark:bg-surface-950 dark:text-surface-100 sm:px-6 lg:px-8" lang="ko">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 dark:border-surface-800 sm:flex-row sm:items-end sm:justify-between">
          <div><div className="text-[11px] font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-primary-300">에이전트 외부 배포</div><h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 dark:text-surface-100 [text-wrap:balance]">에이전트 외부 배포</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-surface-500 [word-break:keep-all]">기존 AI 팀원을 선택하고 공개 범위를 정하면, 외부 사용자가 바로 테스트하고 사용할 수 있는 링크가 생깁니다.</p></div>
          <button type="button" onClick={() => setCreateOpen(true)} className="self-start rounded-xl border border-teal-300 bg-teal-50 px-4 py-2.5 text-sm font-bold text-teal-800 hover:bg-teal-100 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100 dark:hover:bg-primary-500/20">새 외부 배포</button>
        </header>

        <section className="grid grid-cols-2 gap-x-5 gap-y-4 border-b border-slate-200 py-5 dark:border-surface-800 sm:grid-cols-4">
          <div><div className="text-xs text-slate-500 dark:text-surface-600">전체</div><div className="mt-1 text-xl font-bold text-slate-950 dark:text-surface-100">{services.length}</div></div>
          <div><div className="text-xs text-slate-500 dark:text-surface-600">운영 중</div><div className="mt-1 text-xl font-bold text-emerald-700 dark:text-emerald-300">{active}</div></div>
          <div><div className="text-xs text-slate-500 dark:text-surface-600">배포 준비</div><div className="mt-1 text-xl font-bold text-slate-700 dark:text-surface-300">{preparing + review}</div></div>
          <div><div className="text-xs text-slate-500 dark:text-surface-600">접근 중지</div><div className="mt-1 text-xl font-bold text-amber-700 dark:text-amber-300">{paused}</div></div>
        </section>

        <section className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-200 py-4 text-xs text-slate-600 dark:border-surface-800 dark:text-surface-400" aria-label="배포 방법">
          <strong className="text-slate-900 dark:text-surface-100">사용 방법</strong><span>1. AI 팀원 선택</span><span>2. 답변 자료 확인</span><span>3. 이용 범위 설정 후 테스트</span>
        </section>

        <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 py-3 dark:border-surface-800" aria-label="에이전트 외부 배포 상태 필터">
          {FILTERS.map(([key, text]) => <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key} className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold ${filter === key ? 'bg-primary-50 text-primary-800 dark:bg-surface-800 dark:text-primary-200' : 'text-surface-500 hover:text-surface-200'}`}>{text}</button>)}
        </nav>

        <section className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-surface-800 dark:bg-surface-900/45">
          {loading ? <div className="p-12 text-center text-sm text-slate-500 dark:text-surface-500">외부 배포 목록을 불러오는 중…</div>
            : error ? <div className="p-10 text-center"><p className="text-sm text-red-700 dark:text-red-300">{error}</p><button onClick={() => void load()} className="mt-3 text-xs font-semibold text-primary-700 dark:text-primary-300">다시 시도</button></div>
            : visible.length === 0 ? <div className="p-12 text-center"><h2 className="font-bold text-slate-800 dark:text-surface-200">{services.length ? '이 상태의 외부 배포가 없습니다' : '첫 에이전트를 외부 배포해 보세요'}</h2><p className="mt-2 text-sm text-slate-500 dark:text-surface-500">기존 AI 팀원과 공개 범위를 고르면 바로 테스트 가능한 링크가 생깁니다.</p></div>
            : <div className="grid min-h-[520px] lg:grid-cols-[300px_minmax(0,1fr)]">
              <aside className="border-b border-slate-200 dark:border-surface-800 lg:border-b-0 lg:border-r" aria-label="외부 배포 에이전트 목록">
                <div className="border-b border-slate-200 px-4 py-3 text-xs font-bold text-slate-700 dark:border-surface-800 dark:text-surface-300">배포된 에이전트 {visible.length}개</div>
                <div className="max-h-[72vh] overflow-y-auto">{visible.map((service) => <ServiceListItem key={service.id} service={service} selected={service.id === selectedService?.id} onSelect={() => setSelectedServiceId(service.id)} />)}</div>
              </aside>
              <div className="min-w-0 overflow-hidden">{selectedService && <ServiceRow key={selectedService.id} service={selectedService} />}</div>
            </div>}
        </section>
      </div>

      {knowledgePickerOpen && (() => { const project = projects.find((item) => item.id === projectId); return project?.rootPath ? <KnowledgeFilePicker project={{ rootPath: project.rootPath, name: project.agent?.displayName || project.name }} selected={knowledgePaths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)} onApply={(paths) => { setKnowledgePaths(paths.join('\n')); setKnowledgePickerOpen(false); }} onClose={() => setKnowledgePickerOpen(false)} /> : null; })()}
      {createOpen && <div className="fixed inset-0 z-[120] grid place-items-center bg-black/65 p-4 backdrop-blur-sm" onClick={closeCreate}>
        <section className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-950 shadow-2xl dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-ai-service-title">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-primary-300">New External Deployment</div>
          <h2 id="create-ai-service-title" className="mt-1 text-xl font-bold text-slate-950 dark:text-surface-100 [text-wrap:balance]">기존 AI 팀원 외부 배포</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-surface-500 [word-break:keep-all]">AI 팀원 하나를 고르고, 외부 공개 범위만 정하세요. 배포 준비와 접속 링크 생성은 Tower가 자동으로 처리합니다.</p>
          <ol className="mt-4 grid gap-2 text-[11px] text-slate-600 dark:text-surface-400 sm:grid-cols-3" aria-label="에이전트 외부 배포 단계">
            {['AI 팀원 선택', '답변 자료 확인', '이용 범위·배포'].map((step, index) => <li key={step} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-950/45"><span className="mr-2 font-bold text-teal-700 dark:text-primary-300">{index + 1}</span>{step}</li>)}
          </ol>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-slate-700 dark:text-surface-300">외부 배포 이름<input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" placeholder="고객 기술지원 AI" /></label>
            <label className="block text-sm font-semibold text-slate-700 dark:text-surface-300">배포할 AI 팀원<select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500"><option value="">AI 팀원 선택</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.agent?.displayName || project.name}</option>)}</select></label>
          </div>
          <fieldset className="mt-5"><legend className="text-sm font-bold text-slate-800 dark:text-surface-200">AI 모델</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setModelChoice('smart')} aria-pressed={modelChoice === 'smart'} className={`rounded-xl border p-3 text-left ${modelChoice === 'smart' ? 'border-teal-400 bg-teal-50 dark:border-primary-500/45 dark:bg-primary-500/10' : 'border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/45'}`}><span className="block text-sm font-bold text-slate-900 dark:text-surface-100">Smart</span><span className="mt-1 block text-xs text-slate-500 dark:text-surface-500">Tower가 작업에 맞는 모델을 자동 선택합니다.</span></button>
            <button type="button" onClick={() => setModelChoice('harness-default')} aria-pressed={modelChoice === 'harness-default'} className={`rounded-xl border p-3 text-left ${modelChoice === 'harness-default' ? 'border-teal-400 bg-teal-50 dark:border-primary-500/45 dark:bg-primary-500/10' : 'border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/45'}`}><span className="block text-sm font-bold text-slate-900 dark:text-surface-100">Harness 기본 모델</span><span className="mt-1 block text-xs text-slate-500 dark:text-surface-500">선택한 Harness에 고정된 기본 모델을 사용합니다.</span></button>
          </div></fieldset>
          <section className="mt-3 rounded-xl border border-dashed border-violet-300 bg-violet-50/70 p-3 dark:border-violet-500/35 dark:bg-violet-500/8" aria-label="외부 AI API 연동 베타"><div className="flex items-center gap-2"><h3 className="text-sm font-bold text-violet-900 dark:text-violet-100">외부 AI API 연결</h3><span className="rounded-full bg-violet-200 px-2 py-0.5 text-[10px] font-bold text-violet-800 dark:bg-violet-500/20 dark:text-violet-200">베타</span></div><p className="mt-1 text-xs leading-5 text-violet-800/80 dark:text-violet-200/70">OpenAI, Anthropic 등 별도 API를 이 배포에 연결하는 기능을 준비 중입니다.</p><button type="button" disabled className="mt-2 rounded-lg border border-violet-200 bg-white/70 px-3 py-2 text-xs font-semibold text-violet-500 opacity-70 dark:border-violet-500/25 dark:bg-surface-950/30 dark:text-violet-300">외부 AI API 설정 · 준비 중</button></section>
          <fieldset className="mt-5"><legend className="text-sm font-bold text-slate-800 dark:text-surface-200">답변에 사용할 자료</legend>
            <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-surface-800 dark:bg-surface-950/45">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-bold text-slate-900 dark:text-surface-100">배포 자료 연결</div><p className="mt-1 max-w-lg text-xs leading-5 text-slate-500 dark:text-surface-500">선택한 자료의 현재 내용을 배포본에 고정합니다. 원본 파일이 바뀌어도 새로 배포하기 전에는 외부 응답이 달라지지 않습니다.</p></div><span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">Markdown · TXT</span></div>
              <button type="button" disabled={!projectId || !projects.find((item) => item.id === projectId)?.rootPath} onClick={() => setKnowledgePickerOpen(true)} className="mt-3 rounded-lg border border-teal-300 bg-white px-3 py-2 text-xs font-bold text-teal-800 hover:bg-teal-50 disabled:border-slate-200 disabled:text-slate-400 dark:border-primary-500/35 dark:bg-transparent dark:text-primary-200">Finder에서 자료 선택</button>
              {knowledgePaths ? <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-surface-800 dark:bg-surface-900"><div className="text-xs font-bold text-slate-700 dark:text-surface-300">선택한 자료 {knowledgePaths.split(/\r?\n/).filter(Boolean).length}개</div><ul className="mt-2 max-h-28 space-y-1 overflow-y-auto font-mono text-[11px] text-slate-500 dark:text-surface-500">{knowledgePaths.split(/\r?\n/).filter(Boolean).map((item) => <li key={item} className="truncate">{item}</li>)}</ul><button type="button" onClick={() => setKnowledgePaths('')} className="mt-2 text-[11px] font-semibold text-red-600 dark:text-red-300">선택 비우기</button></div> : <p className="mt-3 text-xs text-slate-500 dark:text-surface-500">아직 선택한 자료가 없습니다.</p>}
              <details className="mt-2"><summary className="cursor-pointer text-[11px] font-semibold text-slate-500 dark:text-surface-500">고급 · 경로 직접 입력</summary><textarea value={knowledgePaths} onChange={(event) => setKnowledgePaths(event.target.value)} rows={3} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-500 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-100" placeholder={'knowledge/guide.md\nfinal/customer-faq.txt'} /></details>
              <p className="mt-2 text-[11px] leading-5 text-slate-500 dark:text-surface-600">Tower가 Project 경계·symlink·파일 형식·크기를 서버에서 다시 검사한 뒤 내용을 고정합니다. 비워두면 자료 없이 배포됩니다.</p>
            </div>
          </fieldset>
          <section className="mt-5" aria-labelledby="deployment-capabilities-title">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 id="deployment-capabilities-title" className="text-sm font-bold text-slate-800 dark:text-surface-200">가능한 일</h3><p className="mt-1 text-xs text-slate-500 dark:text-surface-500">기술 도구 대신 외부 사용자가 체감할 업무 수준으로 고릅니다.</p></div><span className="rounded-full border border-violet-300 bg-violet-50 px-2 py-1 text-[10px] font-bold text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200">권한 설계 미리보기</span></div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {[
                ['knowledge', '자료를 찾아 답변', '선택한 문헌 안에서 근거를 찾고 인용합니다.', true],
                ['dataRead', '업무 데이터 조회', '연결한 DB·API에서 허용된 데이터만 읽습니다.', false],
                ['propose', '실행안 제안', '변경 내용을 작성하지만 실제 실행하지 않습니다.', false],
                ['execute', '실제 업무 실행', '승인 정책 안에서 외부 시스템을 변경합니다.', false],
              ].map(([key, title, detail, available]) => { const enabled = capabilityPreview[key as keyof typeof capabilityPreview]; return <button key={String(key)} type="button" disabled={!available && key !== 'knowledge'} onClick={() => setCapabilityPreview((current) => ({ ...current, [String(key)]: !enabled }))} aria-pressed={enabled} className={`rounded-xl border p-3 text-left ${enabled ? 'border-teal-400 bg-teal-50 text-slate-950 dark:border-primary-500/45 dark:bg-primary-500/10 dark:text-surface-100' : 'border-slate-200 bg-white text-slate-700 dark:border-surface-700 dark:bg-surface-950/45 dark:text-surface-300'} disabled:cursor-not-allowed disabled:opacity-70`}><span className="flex items-center justify-between gap-2"><span className="text-sm font-bold">{title}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${available ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200' : 'bg-slate-100 text-slate-500 dark:bg-surface-800 dark:text-surface-500'}`}>{available ? '사용 가능' : '연결 준비 중'}</span></span><span className="mt-1 block text-xs leading-5 opacity-75">{detail}</span></button>; })}
            </div>
          </section>
          <section className="mt-5 rounded-xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-500/20 dark:bg-amber-500/5" aria-labelledby="deployment-approval-title"><h3 id="deployment-approval-title" className="text-sm font-bold text-amber-950 dark:text-amber-100">확인이 필요한 일</h3><p className="mt-1 text-xs text-amber-800/75 dark:text-amber-200/75">실제 실행 권한을 연결할 때 적용할 기본 승인 방식을 미리 정합니다.</p><div className="mt-3 grid gap-2 sm:grid-cols-3">{[
            ['every-time','매번 승인','실행 전 담당자가 확인'],['policy','정책 안에서 자동','금액·대상 등 조건 필요'],['disabled','실행 허용 안 함','답변·조회·제안까지만'],
          ].map(([value,title,detail]) => <button key={value} type="button" onClick={() => setActionApproval(value as typeof actionApproval)} aria-pressed={actionApproval === value} className={`rounded-lg border p-2.5 text-left ${actionApproval === value ? 'border-amber-400 bg-white text-amber-950 dark:border-amber-400/50 dark:bg-amber-500/10 dark:text-amber-100' : 'border-amber-200 bg-transparent text-amber-800 dark:border-amber-500/20 dark:text-amber-200/75'}`}><span className="block text-xs font-bold">{title}</span><span className="mt-1 block text-[10px] leading-4 opacity-75">{detail}</span></button>)}</div></section>
          <fieldset className="mt-5"><legend className="text-sm font-bold text-slate-800 dark:text-surface-200">누가 사용할 수 있나요?</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setShareMode('unlisted')} aria-pressed={shareMode === 'unlisted'} className={`rounded-xl border p-3 text-left ${shareMode === 'unlisted' ? 'border-teal-400 bg-teal-50 dark:border-primary-500/45 dark:bg-primary-500/10' : 'border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/45'}`}><span className="block text-sm font-bold text-slate-900 dark:text-surface-100">링크를 아는 사람</span><span className="mt-1 block text-xs text-slate-500 dark:text-surface-500">가장 간단한 기본 설정입니다.</span></button>
            <button type="button" onClick={() => setShareMode('password')} aria-pressed={shareMode === 'password'} className={`rounded-xl border p-3 text-left ${shareMode === 'password' ? 'border-teal-400 bg-teal-50 dark:border-primary-500/45 dark:bg-primary-500/10' : 'border-slate-200 bg-white dark:border-surface-700 dark:bg-surface-950/45'}`}><span className="block text-sm font-bold text-slate-900 dark:text-surface-100">비밀번호를 아는 사람</span><span className="mt-1 block text-xs text-slate-500 dark:text-surface-500">공유 전에 한 번 더 보호합니다.</span></button>
          </div></fieldset>
          {shareMode === 'password' && <label className="mt-3 block text-sm font-semibold text-slate-700 dark:text-surface-300">공유 비밀번호<input value={sharePassword} onChange={(event) => setSharePassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100 dark:focus:border-primary-500" placeholder="받는 사람에게 전달할 비밀번호" /></label>}
          <section className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-surface-800 dark:bg-surface-950/45" aria-label="외부 배포 승인 요약"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-bold text-slate-900 dark:text-surface-100">외부 배포 승인 요약</h3><span className="text-[10px] font-bold text-teal-700 dark:text-primary-300">배포 전 최종 확인</span></div><dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-slate-500 dark:text-surface-600">자료와 시스템</dt><dd className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{knowledgePaths ? `선택 문헌 ${knowledgePaths.split(/\r?\n/).filter(Boolean).length}개` : '연결 자료 없음'} · 외부 시스템 없음</dd></div><div><dt className="text-slate-500 dark:text-surface-600">가능한 일</dt><dd className="mt-1 font-semibold text-slate-800 dark:text-surface-200">자료 답변{capabilityPreview.dataRead ? ' · 데이터 조회' : ''}{capabilityPreview.propose ? ' · 실행안 제안' : ''}{capabilityPreview.execute ? ' · 실제 실행' : ''}</dd></div><div><dt className="text-slate-500 dark:text-surface-600">확인이 필요한 일</dt><dd className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{actionApproval === 'every-time' ? '실행마다 담당자 승인' : actionApproval === 'policy' ? '승인된 정책 안에서 자동 실행' : '실제 실행 허용 안 함'}</dd></div><div><dt className="text-slate-500 dark:text-surface-600">외부 이용자</dt><dd className="mt-1 font-semibold text-slate-800 dark:text-surface-200">{shareMode === 'password' ? '비밀번호를 아는 사람' : '링크를 아는 사람'}</dd></div></dl><div className="mt-3 rounded-lg bg-white px-3 py-2 text-[11px] leading-5 text-slate-500 ring-1 ring-slate-200 dark:bg-surface-900 dark:text-surface-500 dark:ring-surface-800">불가능: Project 전체 탐색 · 내부 대화·메모리 · Credential 접근 · 자유 SQL · 승인되지 않은 외부 실행</div></section>
          {createError && <p className="mt-3 text-sm text-red-700 dark:text-red-300">{createError}</p>}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-surface-800">
            <p className="max-w-sm text-[11px] leading-5 text-slate-500 dark:text-surface-600">외부 배포가 끝나면 이 화면에서 바로 웹사이트를 열어 대화해 볼 수 있습니다.</p>
            <div className="flex gap-2"><button type="button" onClick={closeCreate} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:border-surface-700 dark:bg-transparent dark:text-surface-300">취소</button><button type="button" disabled={creating || !name.trim() || !projectId || (shareMode === 'password' && !sharePassword.trim())} onClick={() => void createService()} className="rounded-lg border border-teal-300 bg-teal-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-500 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 dark:border-primary-400/35 dark:bg-primary-500/15 dark:text-primary-100 dark:disabled:opacity-40">{creating ? '외부 배포 중…' : '에이전트 외부 배포'}</button></div>
          </div>
        </section>
      </div>}
    </main>
  );
}

export default AIServiceHome;
