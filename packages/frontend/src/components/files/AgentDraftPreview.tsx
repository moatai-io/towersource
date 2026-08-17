import React from 'react';
import { useAgentDraftStore, type AgentDraftArtifact } from '../../stores/agent-draft-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useChatStore } from '../../stores/chat-store';
import { useFileStore } from '../../stores/file-store';
import { AGENT_CHARACTERS, AgentCharacterAvatar, agentFaceImageUrl, characterFace } from '../../features/agent-profile/characters';
import { AgentGoogleConnectionSetup, allowOrganizationGoogleConnection, loadOrganizationGoogleConnections, startDedicatedGoogleOAuth, type AgentGoogleSetup, type OrganizationGoogleConnection } from './AgentGoogleConnectionSetup';

function authHeaders() {
  const token = localStorage.getItem('token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function parseAgentDraft(content: string): AgentDraftArtifact | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') return parsed as AgentDraftArtifact;
  } catch {}
  return null;
}

function expectedExpertiseInput(draft: AgentDraftArtifact) {
  return draft.expectedExpertise ?? draft.role ?? draft.tagline ?? '';
}

const FACE_OPTIONS = ['🧑‍💻', '📄', '💼', '🎧', '📑', '🔎', '🗂️', '🧭', '✨', '🤖'];

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-black uppercase tracking-[0.16em] text-surface-500">{children}</span>;
}

export function AgentDraftPreview({ content }: { content: string }) {
  const addProject = useProjectStore((state) => state.addProject);
  const addSession = useSessionStore((state) => state.addSession);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const storeDraft = useAgentDraftStore((state) => state.currentDraft);
  const setDraft = useAgentDraftStore((state) => state.setDraft);
  const setFace = useAgentDraftStore((state) => state.setFace);
  const updateDraft = useAgentDraftStore((state) => state.updateDraft);
  const parsedDraft = React.useMemo(() => parseAgentDraft(content), [content]);
  const [creating, setCreating] = React.useState(false);
  const [recovery, setRecovery] = React.useState<{ projectName: string; sessionId: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [characterPrompt, setCharacterPrompt] = React.useState('');
  const [characterGenerating, setCharacterGenerating] = React.useState(false);
  const [googleSetup, setGoogleSetup] = React.useState<AgentGoogleSetup>({ mode: 'none' });
  const [organizationGoogleConnections, setOrganizationGoogleConnections] = React.useState<OrganizationGoogleConnection[]>([]);
  const [googleConnectionsLoading, setGoogleConnectionsLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    loadOrganizationGoogleConnections()
      .then((connections) => { if (active) setOrganizationGoogleConnections(connections); })
      .catch(() => { if (active) setOrganizationGoogleConnections([]); })
      .finally(() => { if (active) setGoogleConnectionsLoading(false); });
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    if (parsedDraft) setDraft(parsedDraft);
  }, [parsedDraft, setDraft]);

  const draft = storeDraft || parsedDraft;
  const expertiseInput = draft ? expectedExpertiseInput(draft) : '';
  const expertise = expertiseInput.trim();
  const faceImageUrl = agentFaceImageUrl(draft?.face);
  const canCreate = Boolean(draft?.name.trim() && expertise);

  const generateCharacter = async () => {
    if (!characterPrompt.trim()) return;
    setCharacterGenerating(true);
    setError(null);
    try {
      const response = await fetch('/api/agent-characters/generate', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: characterPrompt, projectId: draft?.sourceProjectId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
      setFace(data.face);
    } catch (caught: any) {
      setError(caught?.message || '캐릭터 생성에 실패했습니다.');
    } finally {
      setCharacterGenerating(false);
    }
  };

  const sourceProjectId = draft?.sourceProjectId || sessions.find((session) => session.id === activeSessionId)?.projectId;
  const bootstrapPayload = draft ? {
    sourceProjectId,
    face: draft.face || '✨',
    name: draft.name.trim(),
    expectedExpertise: expertise,
  } : null;

  const createAgent = async () => {
    if (!bootstrapPayload || !canCreate) {
      setError('이름과 기대하는 전문성을 알려주세요.');
      return;
    }
    if (!sourceProjectId) {
      setError('새 AI 동료 생성 환경을 불러오지 못했습니다. 화면을 다시 열어주세요.');
      return;
    }
    setCreating(true);
    setError(null);
    setRecovery(null);
    try {
      const response = await fetch('/api/primary-agent-commands/bootstrap', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(bootstrapPayload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || `Request failed: ${response.status}`);
      const project = result.project;
      const session = result.session;
      addProject(project);
      if (session?.id) addSession(session);
      if (!session?.id) throw new Error('동료는 생성되었지만 첫 대화를 찾지 못했습니다.');
      setRecovery({ projectName: project.name, sessionId: session.id });
      if (googleSetup.mode === 'organization') {
        await allowOrganizationGoogleConnection(project.id, googleSetup.credentialId);
      } else if (googleSetup.mode === 'dedicated') {
        startDedicatedGoogleOAuth(project.id);
        return;
      }
      try {
        startChat(session.id);
        setRecovery(null);
      } catch (navigationError) {
        console.warn('[agent-draft] created employee but automatic navigation failed', navigationError);
        setRecovery({ projectName: project.name, sessionId: session.id });
        setError('동료는 생성되었습니다. 첫 대화 자동 이동만 완료하지 못했습니다.');
      }
    } catch (caught: any) {
      setError(caught?.message || 'AI 직원 만들기에 실패했습니다.');
    } finally {
      setCreating(false);
    }
  };

  const startChat = (sessionId: string) => {
    setActiveSessionId(sessionId);
    useChatStore.getState().setSessionId(sessionId);
    useChatStore.getState().setEngineSessionId(null);
    useChatStore.getState().clearMessages();
    useFileStore.getState().openChatTab(sessionId);
    const sessionStore = useSessionStore.getState();
    sessionStore.setSidebarTab('sessions');
    if (sessionStore.isMobile) sessionStore.finishMobileContextInChat();
    else {
      sessionStore.setActiveView('chat');
      sessionStore.setSidebarOpen(true);
    }
  };

  if (!draft) {
    return (
      <div className="absolute inset-0 overflow-auto bg-surface-950 p-5">
        <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-red-200">AI 직원 초안을 읽지 못했습니다.</pre>
      </div>
    );
  }

  return (
    <div className="agent-draft-preview absolute inset-0 overflow-auto bg-surface-950 p-5 text-surface-100 font-sans">
      <div className="mx-auto max-w-2xl space-y-5">
        <header className="border-b border-surface-800 pb-5">
          <FieldLabel>새 AI 동료</FieldLabel>
          <h1 className="mt-2 text-2xl font-black tracking-tight text-surface-100">함께 일하고 싶은 사람을 그려주세요</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-surface-400">이름과 기대하는 전문성만 정하면 됩니다. 업무 방식과 필요한 환경은 합류한 뒤 대화하며 맞춰갑니다.</p>
        </header>

        <section className="grid gap-5 rounded-3xl border border-surface-700 bg-surface-900 p-5 shadow-xl shadow-black/20 sm:grid-cols-[112px_1fr]">
          <div className="shrink-0">
            {characterFace(draft.face) ? (
              <AgentCharacterAvatar id={characterFace(draft.face)!} className="h-24 w-24 rounded-3xl ring-1 ring-surface-600" title={`${draft.name || 'AI 직원'} 캐릭터`} />
            ) : faceImageUrl ? (
              <img src={faceImageUrl} alt={`${draft.name || 'AI 직원'} 캐릭터`} className="h-24 w-24 rounded-3xl object-cover ring-1 ring-surface-600" />
            ) : (
              <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-surface-600 bg-surface-850 text-5xl">{draft.face || '✨'}</div>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            <label className="block">
              <FieldLabel>이름</FieldLabel>
              <input
                aria-label="AI employee name"
                value={draft.name || ''}
                onChange={(event) => updateDraft({ name: event.target.value })}
                className="mt-2 w-full rounded-2xl border border-surface-700 bg-surface-950 px-4 py-3 text-lg font-bold text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20"
                placeholder="예: 고객 제안 파트너"
              />
            </label>
            <label className="block">
              <FieldLabel>기대하는 전문성</FieldLabel>
              <textarea
                aria-label="Expected expertise"
                value={expertiseInput}
                onChange={(event) => updateDraft({ expectedExpertise: event.target.value })}
                rows={4}
                className="mt-2 w-full resize-y rounded-2xl border border-surface-700 bg-surface-950 px-4 py-3 text-sm leading-6 text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20"
                placeholder="예: 고객 맥락을 빠르게 이해하고, 설득력 있는 제안 초안과 다음 행동을 준비하는 사람"
              />
            </label>
          </div>
        </section>

        <section className="rounded-3xl border border-surface-700 bg-surface-900 p-4">
            <FieldLabel>얼굴 고르기</FieldLabel>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {AGENT_CHARACTERS.map((character) => (
                <button key={character.id} type="button" title={character.label} onClick={() => setFace(`character:${character.id}`)} aria-label={`${character.label} 캐릭터`} aria-pressed={characterFace(draft.face) === character.id} className={`group overflow-hidden rounded-2xl border p-1 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 ${characterFace(draft.face) === character.id ? 'border-primary-400 bg-primary-500/20' : 'border-surface-700 bg-surface-950 hover:border-surface-500'}`}>
                  <AgentCharacterAvatar id={character.id} className="h-auto w-full rounded-xl" />
                  <span className="block truncate px-1 pb-1 pt-1.5 text-[10px] font-bold text-surface-300">{character.label}</span>
                </button>
              ))}
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-surface-400 hover:text-surface-200">이모지 얼굴 사용</summary>
              <div className="mt-3 grid grid-cols-5 gap-2 sm:grid-cols-10">
                {FACE_OPTIONS.map((face) => <button key={face} type="button" onClick={() => setFace(face)} aria-pressed={draft.face === face} className={`flex h-11 items-center justify-center rounded-2xl border text-xl ${draft.face === face ? 'border-primary-400 bg-primary-500/20' : 'border-surface-700 bg-surface-950'}`}>{face}</button>)}
              </div>
            </details>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-surface-400 hover:text-surface-200">원하는 캐릭터가 없나요?</summary>
              <p className="mt-2 text-xs leading-5 text-surface-500">모습과 분위기를 짧게 적어 새 얼굴을 만들 수 있습니다.</p>
              <textarea value={characterPrompt} onChange={(event) => setCharacterPrompt(event.target.value)} rows={2} placeholder="예: 활기찬 한국인 콘텐츠 전략가, 짧은 곱슬머리, 주황색 셔츠" className="mt-3 w-full rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-100" />
              <button type="button" onClick={generateCharacter} disabled={characterGenerating || !characterPrompt.trim()} className="mt-2 rounded-xl bg-primary-500 px-3 py-2 text-xs font-black text-white hover:bg-primary-400 disabled:opacity-50">{characterGenerating ? '생성 중…' : '새 얼굴 생성'}</button>
            </details>
        </section>

        <AgentGoogleConnectionSetup value={googleSetup} onChange={setGoogleSetup} connections={organizationGoogleConnections} loading={googleConnectionsLoading} />

        <section className="rounded-3xl border border-surface-700 bg-surface-900 p-5 shadow-xl shadow-black/15">
          <h2 className="text-lg font-black text-surface-100">준비되면 바로 함께 일할 수 있어요</h2>
          <p className="mt-1 text-sm leading-6 text-surface-400">생성하면 전용 Workspace와 첫 대화가 만들어지고 새 동료에게 바로 이동합니다. 표시 이름은 어떤 언어로 적어도 됩니다.</p>
          <button type="button" onClick={createAgent} disabled={creating || !canCreate} className="mt-4 w-full rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-black text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
            {creating ? 'AI 동료를 만드는 중…' : !canCreate ? '이름과 기대하는 전문성을 적어주세요' : 'AI 동료 생성하기'}
          </button>

          {recovery && (
            <div className="mt-3 rounded-2xl border border-amber-400/25 bg-amber-500/10 p-4 text-amber-50">
              <div className="font-black">{recovery.projectName} 동료는 생성되었습니다</div>
              <p className="mt-1 text-xs leading-5 text-amber-100/80">자동 이동만 완료하지 못했습니다. 아래 버튼으로 안전하게 다시 열 수 있습니다.</p>
              <button type="button" onClick={() => startChat(recovery.sessionId)} className="mt-3 w-full rounded-2xl bg-primary-500 px-4 py-3 text-sm font-black text-white hover:bg-primary-400">첫 대화 다시 열기</button>
            </div>
          )}

          {error && <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">{error}</div>}
        </section>
      </div>
    </div>
  );
}

export default AgentDraftPreview;
