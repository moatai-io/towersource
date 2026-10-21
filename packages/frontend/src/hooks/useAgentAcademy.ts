import { useCallback, useEffect, useState } from 'react';
import type { AgentDraftArtifact } from '../stores/agent-draft-store';
import { useAgentDraftStore } from '../stores/agent-draft-store';
import { useFileStore } from '../stores/file-store';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';

function buildInitialAgentAcademyDraft(): AgentDraftArtifact {
  return {
    status: 'draft', templateId: 'agent-academy', face: '✨', name: 'AI 직원 후보', levelTitle: '후보 작성 중',
    role: '', expectedExpertise: '', tagline: '', promise: '', capabilities: [], responsibilities: [], strengths: [],
    sourceHints: [], firstTask: '', firstMission: '', promotionGoal: '', needsFromUser: [], worksFor: '',
    accountableOutcome: '', autonomousActions: [], approvalRequiredActions: [], onboardingChecks: [], assumptions: [],
    capabilityRequirements: { required: [], optional: [], forbidden: [] },
    authorityPolicy: { tier: 'project-write', helpersDefaultTier: 'observe' },
    toolPolicy: { canPublishExternal: false },
  };
}

type SendMessage = (message: string, options?: { suppressUserEcho?: boolean }) => void;

export function useAgentAcademy(sendMessage: SendMessage) {
  const [aiTeamSurface, setAiTeamSurface] = useState<'home' | 'creator'>('home');
  const [agentCreatorContent, setAgentCreatorContent] = useState<string | null>(null);

  const openAgentAcademy = useCallback(() => {
    const draft = buildInitialAgentAcademyDraft();
    const projectState = useProjectStore.getState();
    const sessionState = useSessionStore.getState();
    const activeProjectId = sessionState.sessions.find((session) => session.id === sessionState.activeSessionId)?.projectId;
    const sourceProject = projectState.projects.find((project) => project.id === activeProjectId && !project.archived)
      || projectState.projects.find((project) => !project.archived && project.systemKey !== 'ai-talent-team');
    draft.sourceProjectId = sourceProject?.id;
    useAgentDraftStore.getState().setDraft(draft);
    const fileStore = useFileStore.getState();
    fileStore.tabs
      .filter((tab) => /^agent-drafts\/new-agent(?:-\d+)?\.agent-draft\.json$/.test(tab.path))
      .forEach((tab) => useFileStore.getState().closeTab(tab.id));
    setAgentCreatorContent(JSON.stringify(draft, null, 2));
    setAiTeamSurface('creator');
    sessionState.setActiveView('aiTeam');
  }, []);

  const closeAgentAcademy = useCallback(() => {
    setAiTeamSurface('home');
    setAgentCreatorContent(null);
    useAgentDraftStore.getState().setDraft(null);
  }, []);

  const closeAiTeamHome = useCallback(() => {
    // Leave session/message selection intact; only dismiss the application surface.
    useSessionStore.getState().setActiveView('chat');
    useFileStore.getState().activateChatSlot();
  }, []);

  useEffect(() => {
    window.addEventListener('tower-open-ai-team-home', closeAgentAcademy);
    window.addEventListener('tower-start-agent-academy', openAgentAcademy);
    return () => {
      window.removeEventListener('tower-open-ai-team-home', closeAgentAcademy);
      window.removeEventListener('tower-start-agent-academy', openAgentAcademy);
    };
  }, [closeAgentAcademy, openAgentAcademy]);

  useEffect(() => {
    const handler = () => {
      useSessionStore.getState().setActiveView('chat');
      useSessionStore.getState().setSidebarOpen(true);
      void sendMessage('기본 캐릭터 목록에서 원하는 인상을 찾지 못했어요. 같은 Tower 캐릭터 구조를 유지하면서 새 캐릭터를 만들어 주세요. 색감, 인상, 헤어스타일, 소품을 한 번에 하나씩 물어봐 주세요.', { suppressUserEcho: false });
    };
    window.addEventListener('tower-request-custom-agent-character', handler);
    return () => window.removeEventListener('tower-request-custom-agent-character', handler);
  }, [sendMessage]);

  return { aiTeamSurface, agentCreatorContent, closeAgentAcademy, closeAiTeamHome };
}
