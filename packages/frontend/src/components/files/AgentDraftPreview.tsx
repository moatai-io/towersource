import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentDraftStore, type AgentDraftArtifact } from '../../stores/agent-draft-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useChatStore } from '../../stores/chat-store';
import { useFileStore } from '../../stores/file-store';
import { useSettingsStore } from '../../stores/settings-store';
import { AGENT_CHARACTERS, AgentCharacterAvatar, agentFaceImageUrl, characterFace } from '../../features/agent-profile/characters';
import { AgentGoogleConnectionSetup, allowOrganizationGoogleConnection, loadGoogleOAuthReadiness, loadOrganizationGoogleConnections, startDedicatedGoogleOAuth, type AgentGoogleSetup, type GoogleOAuthReadiness, type OrganizationGoogleConnection } from './AgentGoogleConnectionSetup';

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

const STARTER_AGENTS = [
  { id: 'research', characterId: 'korean-diverse-1', nameKey: 'agentCreation.starters.research.name', expertiseKey: 'agentCreation.starters.research.expertise' },
  { id: 'editor', characterId: 'core-editor', nameKey: 'agentCreation.starters.editor.name', expertiseKey: 'agentCreation.starters.editor.expertise' },
  { id: 'operations', characterId: 'korean-diverse-2', nameKey: 'agentCreation.starters.operations.name', expertiseKey: 'agentCreation.starters.operations.expertise' },
  { id: 'guide', characterId: 'korean-diverse-10', nameKey: 'agentCreation.starters.guide.name', expertiseKey: 'agentCreation.starters.guide.expertise' },
] as const;

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-black uppercase tracking-[0.16em] text-surface-500">{children}</span>;
}

export function AgentDraftPreview({ content }: { content: string }) {
  const { t } = useTranslation('files');
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
  const [characterGenerationReady, setCharacterGenerationReady] = React.useState(false);
  const [googleSetup, setGoogleSetup] = React.useState<AgentGoogleSetup>({ mode: 'none' });
  const [organizationGoogleConnections, setOrganizationGoogleConnections] = React.useState<OrganizationGoogleConnection[]>([]);
  const [googleOAuthReadiness, setGoogleOAuthReadiness] = React.useState<GoogleOAuthReadiness | null>(null);
  const [googleConnectionsLoading, setGoogleConnectionsLoading] = React.useState(true);
  const googleDisplayMode = useSettingsStore((state) => state.serverConfig?.uiCapabilities?.agentCreation?.googleConnection ?? 'hidden');

  React.useEffect(() => {
    if (googleDisplayMode === 'hidden') {
      setGoogleOAuthReadiness(null);
      setOrganizationGoogleConnections([]);
      setGoogleSetup({ mode: 'none' });
      setGoogleConnectionsLoading(false);
      return;
    }
    let active = true;
    setGoogleConnectionsLoading(true);
    Promise.all([loadGoogleOAuthReadiness(), loadOrganizationGoogleConnections()])
      .then(([readiness, connections]) => {
        if (!active) return;
        setGoogleOAuthReadiness(readiness);
        setOrganizationGoogleConnections(readiness.ready ? connections : []);
        if (!readiness.ready) setGoogleSetup({ mode: 'none' });
      })
      .catch(() => {
        if (!active) return;
        setGoogleOAuthReadiness(null);
        setOrganizationGoogleConnections([]);
        setGoogleSetup({ mode: 'none' });
      })
      .finally(() => { if (active) setGoogleConnectionsLoading(false); });
    return () => { active = false; };
  }, [googleDisplayMode]);

  React.useEffect(() => {
    if (parsedDraft) setDraft(parsedDraft);
  }, [parsedDraft, setDraft]);

  const draft = storeDraft || parsedDraft;
  const sourceProjectId = draft?.sourceProjectId || sessions.find((session) => session.id === activeSessionId)?.projectId;

  React.useEffect(() => {
    if (!sourceProjectId) {
      setCharacterGenerationReady(false);
      return;
    }
    let active = true;
    fetch(`/api/agent-characters/readiness?projectId=${encodeURIComponent(sourceProjectId)}`, { headers: authHeaders(), cache: 'no-store' })
      .then((response) => response.ok ? response.json() : { ready: false })
      .then((result) => { if (active) setCharacterGenerationReady(result?.ready === true); })
      .catch(() => { if (active) setCharacterGenerationReady(false); });
    return () => { active = false; };
  }, [sourceProjectId]);
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
        body: JSON.stringify({ prompt: characterPrompt, projectId: sourceProjectId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
      setFace(data.face);
    } catch (caught: any) {
      setError(caught?.message || t('agentCreation.characterFailed'));
    } finally {
      setCharacterGenerating(false);
    }
  };

  const bootstrapPayload = draft ? {
    sourceProjectId,
    face: draft.face || '✨',
    name: draft.name.trim(),
    expectedExpertise: expertise,
  } : null;

  const createAgent = async () => {
    if (!bootstrapPayload || !canCreate) {
      setError(t('agentCreation.nameExpertiseRequired'));
      return;
    }
    if (!sourceProjectId) {
      setError(t('agentCreation.environmentUnavailable'));
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
      if (!session?.id) throw new Error(t('agentCreation.sessionMissing'));
      setRecovery({ projectName: project.name, sessionId: session.id });
      if (googleSetup.mode === 'organization') {
        await allowOrganizationGoogleConnection(project.id, googleSetup.credentialId);
      } else if (googleSetup.mode === 'dedicated') {
        await startDedicatedGoogleOAuth(project.id);
        return;
      }
      try {
        startChat(session.id);
        setRecovery(null);
      } catch (navigationError) {
        console.warn('[agent-draft] created employee but automatic navigation failed', navigationError);
        setRecovery({ projectName: project.name, sessionId: session.id });
        setError(t('agentCreation.navigationFailed'));
      }
    } catch (caught: any) {
      setError(caught?.message || t('agentCreation.creationFailed'));
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
        <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-red-200">{t('agentCreation.draftUnreadable')}</pre>
      </div>
    );
  }

  return (
    <div className="agent-draft-preview absolute inset-0 overflow-auto bg-surface-950 p-5 text-surface-100 font-sans">
      <div className="mx-auto max-w-2xl space-y-5">
        <header className="border-b border-surface-800 pb-5">
          <FieldLabel>{t('agentCreation.newAiTeammate')}</FieldLabel>
          <h1 className="mt-2 text-2xl font-black tracking-tight text-surface-100">{t('agentCreation.heading')}</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-surface-400">{t('agentCreation.description')}</p>
        </header>

        <section className="rounded-3xl border border-surface-700 bg-surface-900 p-4">
          <FieldLabel>{t('agentCreation.starters.label')}</FieldLabel>
          <p className="mt-2 text-xs leading-5 text-surface-500">{t('agentCreation.starters.description')}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {STARTER_AGENTS.map((starter) => (
              <button
                key={starter.id}
                type="button"
                onClick={() => updateDraft({ face: `character:${starter.characterId}`, name: t(starter.nameKey), expectedExpertise: t(starter.expertiseKey), role: t(starter.expertiseKey) })}
                className="flex min-h-20 items-center gap-3 rounded-2xl border border-surface-700 bg-surface-950/70 p-3 text-left transition-colors hover:border-primary-500/50 hover:bg-primary-500/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70"
              >
                <AgentCharacterAvatar id={starter.characterId} className="h-12 w-12 shrink-0 rounded-xl" title={t(starter.nameKey)} />
                <span className="min-w-0"><span className="block text-sm font-bold text-surface-100">{t(starter.nameKey)}</span><span className="mt-1 line-clamp-2 block text-[11px] leading-4 text-surface-500">{t(starter.expertiseKey)}</span></span>
              </button>
            ))}
          </div>
        </section>

        <section className="grid gap-5 rounded-3xl border border-surface-700 bg-surface-900 p-5 shadow-xl shadow-black/20 sm:grid-cols-[112px_1fr]">
          <div className="shrink-0">
            {characterFace(draft.face) ? (
              <AgentCharacterAvatar id={characterFace(draft.face)!} className="h-24 w-24 rounded-3xl ring-1 ring-surface-600" title={t('agentCreation.characterLabel', { name: draft.name || t('agentCreation.employeeFallback') })} />
            ) : faceImageUrl ? (
              <img src={faceImageUrl} alt={t('agentCreation.characterLabel', { name: draft.name || t('agentCreation.employeeFallback') })} className="h-24 w-24 rounded-3xl object-cover ring-1 ring-surface-600" />
            ) : (
              <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-surface-600 bg-surface-850 text-5xl">{draft.face || '✨'}</div>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            <label className="block">
              <FieldLabel>{t('agentCreation.name')}</FieldLabel>
              <input
                aria-label="AI employee name"
                value={draft.name || ''}
                onChange={(event) => updateDraft({ name: event.target.value })}
                className="mt-2 w-full rounded-2xl border border-surface-700 bg-surface-950 px-4 py-3 text-lg font-bold text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20"
                placeholder={t('agentCreation.namePlaceholder')}
              />
            </label>
            <label className="block">
              <FieldLabel>{t('agentCreation.expectedExpertise')}</FieldLabel>
              <textarea
                aria-label="Expected expertise"
                value={expertiseInput}
                onChange={(event) => updateDraft({ expectedExpertise: event.target.value })}
                rows={4}
                className="mt-2 w-full resize-y rounded-2xl border border-surface-700 bg-surface-950 px-4 py-3 text-sm leading-6 text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-400 focus:ring-2 focus:ring-primary-500/20"
                placeholder={t('agentCreation.expertisePlaceholder')}
              />
            </label>
          </div>
        </section>

        <section className="rounded-3xl border border-surface-700 bg-surface-900 p-4">
            <FieldLabel>{t('agentCreation.chooseFace')}</FieldLabel>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {AGENT_CHARACTERS.map((character) => {
                const characterLabel = t(`agentCreation.characterLabels.${character.id}`);
                return (
                <button key={character.id} type="button" title={characterLabel} onClick={() => setFace(`character:${character.id}`)} aria-label={t('agentCreation.characterLabel', { name: characterLabel })} aria-pressed={characterFace(draft.face) === character.id} className={`group overflow-hidden rounded-2xl border p-1 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 ${characterFace(draft.face) === character.id ? 'border-primary-400 bg-primary-500/20' : 'border-surface-700 bg-surface-950 hover:border-surface-500'}`}>
                  <AgentCharacterAvatar id={character.id} className="h-auto w-full rounded-xl" />
                  <span className="block truncate px-1 pb-1 pt-1.5 text-[10px] font-bold text-surface-300">{characterLabel}</span>
                </button>
                );
              })}
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-surface-400 hover:text-surface-200">{t('agentCreation.useEmojiFace')}</summary>
              <div className="mt-3 grid grid-cols-5 gap-2 sm:grid-cols-10">
                {FACE_OPTIONS.map((face) => <button key={face} type="button" onClick={() => setFace(face)} aria-pressed={draft.face === face} className={`flex h-11 items-center justify-center rounded-2xl border text-xl ${draft.face === face ? 'border-primary-400 bg-primary-500/20' : 'border-surface-700 bg-surface-950'}`}>{face}</button>)}
              </div>
            </details>
            {characterGenerationReady ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-semibold text-surface-400 hover:text-surface-200">{t('agentCreation.customCharacterQuestion')}</summary>
                <p className="mt-2 text-xs leading-5 text-surface-500">{t('agentCreation.customCharacterDescription')}</p>
                <textarea value={characterPrompt} onChange={(event) => setCharacterPrompt(event.target.value)} rows={2} placeholder={t('agentCreation.customCharacterPlaceholder')} className="mt-3 w-full rounded-xl border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-100" />
                <button type="button" onClick={generateCharacter} disabled={characterGenerating || !characterPrompt.trim()} className="mt-2 rounded-xl bg-primary-500 px-3 py-2 text-xs font-black text-white hover:bg-primary-400 disabled:opacity-50">{characterGenerating ? t('agentCreation.generating') : t('agentCreation.generateNewFace')}</button>
              </details>
            ) : (
              <p className="mt-3 text-xs leading-5 text-surface-500">{t('agentCreation.customCharacterConnectionRequired')}</p>
            )}
        </section>

        {googleDisplayMode === 'inline' && (
          <AgentGoogleConnectionSetup value={googleSetup} onChange={setGoogleSetup} connections={organizationGoogleConnections} readiness={googleOAuthReadiness} loading={googleConnectionsLoading} />
        )}
        {googleDisplayMode === 'optional' && (
          <details className="rounded-3xl border border-surface-700 bg-surface-900 p-5">
            <summary className="cursor-pointer text-sm font-bold text-surface-300">{t('agentCreation.optionalConnections')}</summary>
            <div className="mt-4">
              <AgentGoogleConnectionSetup value={googleSetup} onChange={setGoogleSetup} connections={organizationGoogleConnections} readiness={googleOAuthReadiness} loading={googleConnectionsLoading} />
            </div>
          </details>
        )}
        {googleDisplayMode === 'hidden' && (
          <p className="rounded-2xl border border-surface-800 bg-surface-900/70 px-4 py-3 text-xs leading-5 text-surface-500">{t('agentCreation.connectionsLater')}</p>
        )}

        <section className="rounded-3xl border border-surface-700 bg-surface-900 p-5 shadow-xl shadow-black/15">
          <h2 className="text-lg font-black text-surface-100">{t('agentCreation.readyHeading')}</h2>
          <p className="mt-1 text-sm leading-6 text-surface-400">{t('agentCreation.readyDescription')}</p>
          <button type="button" onClick={createAgent} disabled={creating || !canCreate} className="mt-4 w-full rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-black text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
            {creating ? t('agentCreation.creating') : !canCreate ? t('agentCreation.requiredPrompt') : t('agentCreation.create')}
          </button>

          {recovery && (
            <div className="mt-3 rounded-2xl border border-amber-400/25 bg-amber-500/10 p-4 text-amber-50">
              <div className="font-black">{t('agentCreation.recoveryCreated', { name: recovery.projectName })}</div>
              <p className="mt-1 text-xs leading-5 text-amber-100/80">{t('agentCreation.recoveryDescription')}</p>
              <button type="button" onClick={() => startChat(recovery.sessionId)} className="mt-3 w-full rounded-2xl bg-primary-500 px-4 py-3 text-sm font-black text-white hover:bg-primary-400">{t('agentCreation.reopenConversation')}</button>
            </div>
          )}

          {error && <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">{error}</div>}
        </section>
      </div>
    </div>
  );
}

export default AgentDraftPreview;
