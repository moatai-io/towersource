import { useCallback, useEffect, useRef } from 'react';
import type { SendOptions } from '../components/chat/InputBox';
import type { SessionMeta } from '../stores/session-store';
import { useChatStore } from '../stores/chat-store';
import { useFileStore } from '../stores/file-store';
import { useSessionStore } from '../stores/session-store';

type CreateSession = (name?: string, projectId?: string, label?: string) => Promise<SessionMeta | null | undefined>;
type RuntimeSendOptions = SendOptions & { cwd?: string; suppressUserEcho?: boolean; sourceReference?: unknown };
type SendMessage = (message: string, cwdOrOptions?: string | RuntimeSendOptions, maybeOptions?: SendOptions) => void;

type Options = {
  sendMessage: SendMessage;
  createSessionInDb: CreateSession;
  setActiveSessionId: (id: string | null) => void;
  clearMessages: () => void;
  setActiveRuntimeSession: (sessionId: string) => void;
};

export function useMessageExecution({
  sendMessage,
  createSessionInDb,
  setActiveSessionId,
  clearMessages,
  setActiveRuntimeSession,
}: Options) {
  const creatingSession = useRef(false);
  const replayBranchPromptKeysRef = useRef(new Set<string>());

  const handleSendMessage = useCallback(async (message: string, cwdOrOptions?: string | SendOptions, maybeOptions?: SendOptions) => {
    const cwd = typeof cwdOrOptions === 'string' ? cwdOrOptions : undefined;
    const sendOptions = typeof cwdOrOptions === 'string' ? maybeOptions : cwdOrOptions;
    if (useFileStore.getState().activeTabId !== null) useFileStore.getState().activateChatSlot();
    if (!useSessionStore.getState().activeSessionId) {
      if (creatingSession.current) return;
      creatingSession.current = true;
      try {
        const session = await createSessionInDb();
        if (session) {
          setActiveSessionId(session.id);
          useChatStore.getState().setSessionId(session.id);
          useFileStore.getState().openChatTab(session.id);
        }
      } finally {
        creatingSession.current = false;
      }
    }
    const activeSession = useSessionStore.getState().sessions.find(
      (session) => session.id === useSessionStore.getState().activeSessionId,
    );
    sendMessage(message, { ...(sendOptions || {}), cwd: cwd || activeSession?.cwd });
  }, [createSessionInDb, sendMessage, setActiveSessionId]);

  useEffect(() => {
    const pendingTimers = new Set<number>();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; prompt?: string; cwd?: string }>).detail ?? {};
      const sessionId = detail.sessionId;
      const prompt = detail.prompt?.trim();
      if (!sessionId || !prompt) return;
      const replayKey = `${sessionId}:${prompt}`;
      if (replayBranchPromptKeysRef.current.has(replayKey)) return;
      let attempts = 0;
      const tryReplay = () => {
        attempts += 1;
        if (useSessionStore.getState().activeSessionId === sessionId && useChatStore.getState().sessionId === sessionId) {
          replayBranchPromptKeysRef.current.add(replayKey);
          sendMessage(prompt, { cwd: detail.cwd, suppressUserEcho: false });
          return;
        }
        if (attempts >= 40) return;
        const timer = window.setTimeout(() => {
          pendingTimers.delete(timer);
          tryReplay();
        }, 100);
        pendingTimers.add(timer);
      };
      tryReplay();
    };
    window.addEventListener('tower-replay-branch-prompt', handler);
    return () => {
      window.removeEventListener('tower-replay-branch-prompt', handler);
      for (const timer of pendingTimers) window.clearTimeout(timer);
      pendingTimers.clear();
    };
  }, [sendMessage]);

  useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; prompt?: string; sessionName?: string; label?: string | null }>).detail ?? {};
      const prompt = detail.prompt?.trim();
      if (!prompt) return;
      const session = await createSessionInDb(
        detail.sessionName,
        detail.projectId || undefined,
        detail.label === null ? undefined : (detail.label || undefined),
      );
      if (!session) return;
      setActiveSessionId(session.id);
      useChatStore.getState().setSessionId(session.id);
      useChatStore.getState().setEngineSessionId(null);
      clearMessages();
      setActiveRuntimeSession(session.id);
      useFileStore.getState().openChatTab(session.id);
      useSessionStore.getState().setActiveView('chat');
      useSessionStore.getState().setSidebarTab('sessions');
      useSessionStore.getState().setSidebarOpen(true);
      window.setTimeout(() => sendMessage(prompt, { cwd: session.cwd }), 250);
    };
    window.addEventListener('tower-start-prompt-session', handler);
    window.addEventListener('tower-start-schedule-wizard', handler);
    return () => {
      window.removeEventListener('tower-start-prompt-session', handler);
      window.removeEventListener('tower-start-schedule-wizard', handler);
    };
  }, [clearMessages, createSessionInDb, sendMessage, setActiveRuntimeSession, setActiveSessionId]);

  useEffect(() => {
    const handler = (event: Event) => {
      const command = (event as CustomEvent<{ command?: string }>).detail?.command?.trim();
      if (!command) return;
      useSessionStore.getState().setActiveView('chat');
      useFileStore.getState().activateChatSlot();
      void handleSendMessage(command);
    };
    window.addEventListener('tower-run-agent-command', handler);
    return () => window.removeEventListener('tower-run-agent-command', handler);
  }, [handleSendMessage]);

  return { handleSendMessage };
}
