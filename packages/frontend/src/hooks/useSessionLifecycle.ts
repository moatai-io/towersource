import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ConfirmOptions } from './useDialog';
import { useChatStore } from '../stores/chat-store';
import { useFileStore } from '../stores/file-store';
import { getEngineFromModel, getModelIdForBackend, getNewSessionModel } from '../stores/model-store';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore, type SessionMeta } from '../stores/session-store';
import { toastError, toastQuiet } from '../utils/toast';

const API_BASE = '/api';

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

interface UseSessionLifecycleOptions {
  token: string | null;
  setActiveRuntimeSession: (sessionId: string, engineSessionId?: string | null) => void;
  confirmSessionArchive: Confirm;
  t: TFunction<['auth', 'layout']>;
}

export function useSessionLifecycle({ token, setActiveRuntimeSession, confirmSessionArchive, t }: UseSessionLifecycleOptions) {
  const [newSessionCreating, setNewSessionCreating] = useState(false);
  const newSessionCreatingRef = useRef(false);

  const createSessionInDb = useCallback(async (name?: string, projectId?: string, label?: string, visibility?: 'private' | 'project'): Promise<SessionMeta | null> => {
    try {
      let resolvedProjectId = projectId;
      if (!resolvedProjectId) {
        const { sessions, activeSessionId } = useSessionStore.getState();
        resolvedProjectId = sessions.find((session) => session.id === activeSessionId)?.projectId || undefined;
        if (!resolvedProjectId) {
          resolvedProjectId = [...sessions]
            .filter((session) => session.projectId && !session.roomId)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.projectId || undefined;
        }
        if (!resolvedProjectId) {
          resolvedProjectId = useProjectStore.getState().projects.find((project) => project.name.toLowerCase() === 'general' || project.rootPath?.endsWith('/general'))?.id;
        }
      }

      const project = resolvedProjectId ? useProjectStore.getState().projects.find((candidate) => candidate.id === resolvedProjectId) : null;
      const currentSession = useSessionStore.getState().sessions.find((session) => session.id === useSessionStore.getState().activeSessionId);
      const cwd = project?.rootPath || currentSession?.cwd || undefined;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const selectedModel = getNewSessionModel();
      const body: Record<string, unknown> = {
        name: name || `Session ${new Date().toLocaleString('en-US')}`,
        cwd,
        engine: getEngineFromModel(selectedModel),
        modelUsed: getModelIdForBackend(selectedModel),
      };
      if (resolvedProjectId) body.projectId = resolvedProjectId;
      if (label?.trim()) body.label = label.trim();
      if (visibility) body.visibility = visibility;
      const response = await fetch(`${API_BASE}/sessions`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!response.ok) return null;
      const session = await response.json();
      useSessionStore.getState().addSession(session);
      return session;
    } catch (error) {
      console.warn('[session-lifecycle] createSessionInDb failed:', error);
      return null;
    }
  }, [token]);

  const activateCreatedSession = useCallback((session: SessionMeta) => {
    const chat = useChatStore.getState();
    // A new conversation starts in chat, not in an old file or Viewer preview.
    // Keep file tabs in the working set without presenting them implicitly.
    useFileStore.getState().activateChatSlot();
    useFileStore.getState().setContextPanelOpen(false);
    useSessionStore.getState().setActiveSessionId(session.id);
    chat.setSessionId(session.id);
    chat.setEngineSessionId(null);
    chat.clearMessages();
    setActiveRuntimeSession(session.id);
    useFileStore.getState().openChatTab(session.id);
  }, [setActiveRuntimeSession]);

  const handleNewSession = useCallback(async (projectId?: string, label?: string) => {
    if (newSessionCreatingRef.current) return;
    newSessionCreatingRef.current = true;
    setNewSessionCreating(true);
    // Show chat as soon as creation is requested, including connection failures.
    // Do not expose the previously focused file while the request is pending.
    useFileStore.getState().activateChatSlot();
    useFileStore.getState().setContextPanelOpen(false);
    if (useSessionStore.getState().isMobile && useSessionStore.getState().mobileContextOpen) {
      useSessionStore.getState().finishMobileContextInChat();
    }
    const chat = useChatStore.getState();
    chat.setStreaming(false);
    chat.setSessionLoading(false);
    try {
      const session = await createSessionInDb(undefined, projectId, label);
      if (!session) {
        toastError(t('layout:newSessionCreateFailed'));
        return;
      }
      activateCreatedSession(session);
      window.dispatchEvent(new CustomEvent('tower-reveal-session-in-sidebar', {
        detail: { sessionId: session.id, projectId: session.projectId ?? projectId ?? null, label: session.label ?? label ?? null, origin: 'created' },
      }));
      useSessionStore.getState().setActiveView('chat');
      // Do not reopen the mobile drawer after the async create request finishes.
      if (!useSessionStore.getState().isMobile) useSessionStore.getState().setSidebarOpen(true);
    } finally {
      newSessionCreatingRef.current = false;
      setNewSessionCreating(false);
    }
  }, [activateCreatedSession, createSessionInDb, t]);

  const handleNewSessionInFolder = useCallback(async (cwd: string) => {
    useFileStore.getState().activateChatSlot();
    useFileStore.getState().setContextPanelOpen(false);
    if (useSessionStore.getState().isMobile && useSessionStore.getState().mobileContextOpen) {
      useSessionStore.getState().finishMobileContextInChat();
    }
    useChatStore.getState().setStreaming(false);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${API_BASE}/sessions`, {
        method: 'POST', headers, body: JSON.stringify({ name: `Session ${new Date().toLocaleString('en-US')}`, cwd, engine: 'pi', modelUsed: getModelIdForBackend(getNewSessionModel()) }),
      });
      if (response.ok) {
        const session = await response.json();
        useSessionStore.getState().addSession(session);
        activateCreatedSession(session);
      }
    } catch (error) {
      console.warn('[session-lifecycle] handleNewSessionInFolder failed:', error);
    }
  }, [activateCreatedSession, token]);

  const handleDeleteSession = useCallback(async (id: string) => {
    if (!(await confirmSessionArchive({
      title: t('layout:deleteSession'), message: t('layout:sessionTrashSharedWarning'),
      confirmLabel: t('layout:deleteSession'), danger: false,
    }))) return;
    try {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${API_BASE}/sessions/${id}/archive`, { method: 'POST', headers });
      if (!response.ok) throw new Error(`archive failed: ${response.status}`);
      useSessionStore.getState().removeSession(id);
      useChatStore.getState().clearSessionQueue(id);
      toastQuiet(t('layout:sessionTrashMoved'), {
        action: { label: t('layout:sessionTrash'), onClick: () => window.dispatchEvent(new CustomEvent('tower-open-session-archive')) },
      });
    } catch (error) {
      console.warn('[session-lifecycle] handleDeleteSession failed:', error);
      toastError(t('layout:sessionTrashDeleteFailed'));
    }
  }, [confirmSessionArchive, t, token]);

  const patchSession = useCallback(async (id: string, patch: Record<string, unknown>) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      await fetch(`${API_BASE}/sessions/${id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
      useSessionStore.getState().updateSessionMeta(id, patch);
    } catch (error) {
      console.warn('[session-lifecycle] patchSession failed:', error);
    }
  }, [token]);

  const handleRenameSession = useCallback((id: string, name: string) => patchSession(id, { name, autoNamed: 0 }), [patchSession]);
  const handleToggleFavorite = useCallback((id: string, favorite: boolean) => patchSession(id, { favorite }), [patchSession]);

  return { newSessionCreating, createSessionInDb, handleNewSession, handleNewSessionInFolder, handleDeleteSession, handleRenameSession, handleToggleFavorite };
}
