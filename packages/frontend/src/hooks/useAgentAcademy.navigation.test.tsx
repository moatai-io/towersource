// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentAcademy } from './useAgentAcademy';
import { useSessionStore } from '../stores/session-store';
import { useFileStore } from '../stores/file-store';
import { useChatStore } from '../stores/chat-store';
import { AppContentRouter } from '../components/layout/AppContentRouter';

function selectedSurface() {
  const files = useFileStore.getState();
  return <AppContentRouter
    activeView={useSessionStore.getState().activeView}
    hasActiveFileTab={Boolean(files.activeTabId)}
    hasActiveSystemTab={Boolean(files.activeSystemTabId)}
    sessionDirectory={null} schedules={null} inbox={null} work={null} favorites={null}
    aiTeam={<div>AI Team home</div>} aiServices={null} aiServicesEnabled={false}
    beta={null} projectFiles={null} systemTab={<div>Project home</div>}
    fallback={<div>Existing chat</div>}
  />;
}

describe('AI Team home return to chat', () => {
  beforeEach(() => {
    useFileStore.getState().closeAllTabs();
    useSessionStore.setState({ activeView: 'aiTeam', activeSessionId: 'existing-chat' });
    useChatStore.setState({ sessionId: 'existing-chat' });
  });
  afterEach(() => {
    cleanup();
    useFileStore.getState().closeAllTabs();
    useSessionStore.setState({ activeView: 'chat', activeSessionId: null });
    useChatStore.setState({ sessionId: null });
  });

  it.each(['file', 'system', 'none'] as const)('dismisses a stale %s tab selection without changing the chat or closing tabs', (tab) => {
    const files = useFileStore.getState();
    files.openChatTab('existing-chat', 'Current conversation');
    if (tab === 'file') files.openTab('/workspace/note.md', 'Note', 'markdown', 'utf-8');
    if (tab === 'system') files.openSystemTab('projectFiles', { refId: 'project-a', title: 'Project home' });
    const tabs = useFileStore.getState().tabs;
    const systemTabs = useFileStore.getState().systemTabs;
    const messages = useChatStore.getState().messages;
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useAgentAcademy(sendMessage));
    act(() => result.current.closeAiTeamHome());
    const state = useFileStore.getState();
    expect(useSessionStore.getState().activeView).toBe('chat');
    expect(useSessionStore.getState().activeSessionId).toBe('existing-chat');
    expect(useChatStore.getState().sessionId).toBe('existing-chat');
    expect(useChatStore.getState().messages).toBe(messages);
    expect(state.activeTabId).toBeNull();
    expect(state.activeSystemTabId).toBeNull();
    expect(state.tabs).toBe(tabs);
    expect(state.systemTabs).toBe(systemTabs);
    expect(sendMessage).not.toHaveBeenCalled();
    render(selectedSurface());
    expect(screen.getByText('Existing chat')).toBeTruthy();
    expect(screen.queryByText('AI Team home')).toBeNull();
    expect(screen.queryByText('Project home')).toBeNull();
  });

  it('returns to the empty chat surface when no conversation was selected', () => {
    useSessionStore.setState({ activeSessionId: null });
    useChatStore.setState({ sessionId: null });
    const { result } = renderHook(() => useAgentAcademy(vi.fn()));
    act(() => result.current.closeAiTeamHome());
    expect(useSessionStore.getState().activeView).toBe('chat');
    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(useChatStore.getState().sessionId).toBeNull();
  });

  it('keeps the creator close action scoped to AI Team home', () => {
    const { result } = renderHook(() => useAgentAcademy(vi.fn()));
    act(() => result.current.closeAgentAcademy());
    expect(result.current.aiTeamSurface).toBe('home');
    expect(useSessionStore.getState().activeView).toBe('aiTeam');
  });
});
