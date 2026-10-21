import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const lifecycle = readFileSync(new URL('./useSessionLifecycle.ts', import.meta.url), 'utf8');

describe('session lifecycle ownership', () => {
  it('keeps App on handler wiring while the hook owns session mutations', () => {
    expect(app).toContain('useSessionLifecycle({ token, setActiveRuntimeSession: setActiveSession');
    expect(app).not.toContain('const handleNewSession = useCallback');
    expect(app).not.toContain('const handleDeleteSession = useCallback');
    expect(app).not.toContain('const handleRenameSession = useCallback');
    expect(lifecycle).toContain('export function useSessionLifecycle');
  });

  it('owns creation, folder creation, archive, rename, and favorite updates', () => {
    expect(lifecycle).toContain('const createSessionInDb = useCallback');
    expect(lifecycle).toContain('const handleNewSession = useCallback');
    expect(lifecycle).toContain('const handleNewSessionInFolder = useCallback');
    expect(lifecycle).toContain('const handleDeleteSession = useCallback');
    expect(lifecycle).toContain('const handleRenameSession = useCallback');
    expect(lifecycle).toContain('const handleToggleFavorite = useCallback');
  });

  it('starts both regular and folder sessions with Core rather than the last picked model', () => {
    expect(lifecycle).toContain('const selectedModel = getNewSessionModel()');
    expect(lifecycle).toContain('modelUsed: getModelIdForBackend(getNewSessionModel())');
    expect(lifecycle).not.toContain('useModelStore.getState().selectedModel');
  });

  it('activates newly created sessions through stores and runtime together', () => {
    expect(lifecycle).toContain('const activateCreatedSession = useCallback');
    expect(lifecycle).toContain('useFileStore.getState().activateChatSlot()');
    expect(lifecycle).toContain('useFileStore.getState().setContextPanelOpen(false)');
    expect(lifecycle).toContain('setActiveSessionId(session.id)');
    expect(lifecycle).toContain('chat.setSessionId(session.id)');
    expect(lifecycle).toContain('setActiveRuntimeSession(session.id)');
    expect(lifecycle).toContain('openChatTab(session.id)');
  });
});
