// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AiPanel } from './AiPanel';
import { useAiPanelStore } from '../../stores/ai-panel-store';
import { useRoomStore } from '../../stores/room-store';
import { useSessionStore } from '../../stores/session-store';

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  localStorage.clear();
  if (!HTMLElement.prototype.setPointerCapture) {
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true });
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
  }

  (window as any).__towerWs = {
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    send: vi.fn(),
  };

  useAiPanelStore.setState({
    open: true,
    contextType: 'room',
    contextId: 'room-1',
    roomId: 'room-1',
    threads: [{
      id: 'thread-1',
      name: 'Thread 1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any],
    activeThreadId: 'thread-1',
    messages: [],
    isStreaming: true,
    pendingQuestion: {
      questionId: 'q-1',
      sessionId: 'thread-1',
      questions: [
        {
          question: '환경을 선택해 주세요',
          options: [{ label: '개발' }, { label: '운영' }],
        },
      ],
    },
    loading: false,
  });

  useRoomStore.setState({ activeRoomId: 'room-1' } as any);
  useSessionStore.setState({ isMobile: false } as any);
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('AiPanel mobile input timing', () => {
  it('sends the live textarea value when Enter arrives before state commit', async () => {
    useAiPanelStore.setState({ isStreaming: false, pendingQuestion: null });
    render(<AiPanel />);

    const input = await screen.findByPlaceholderText('Ask AI...') as HTMLTextAreaElement;
    input.value = '패널에 붙여넣은 최신 글';
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect((window as any).__towerWs.send).toHaveBeenCalledWith(expect.stringContaining('패널에 붙여넣은 최신 글'));
  });

  it('does not submit Android IME keyCode 229', async () => {
    useAiPanelStore.setState({ isStreaming: false, pendingQuestion: null });
    render(<AiPanel />);

    const input = await screen.findByPlaceholderText('Ask AI...') as HTMLTextAreaElement;
    input.value = '조합 중';
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect((window as any).__towerWs.send).not.toHaveBeenCalled();
  });
});

describe('AiPanel AskUserQuestion UI', () => {
  it('renders floating question UI for panel threads', async () => {
    render(<AiPanel />);

    expect(await screen.findByText('AI is asking')).toBeInTheDocument();
    expect(screen.getByText('환경을 선택해 주세요')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '개발' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '운영' })).toBeInTheDocument();
  });
});

describe('AiPanel empty thread draft', () => {
  it('shows an unsaved draft with sample prompts when the panel context has no threads', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/sessions?')) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => [] };
    });

    useAiPanelStore.setState({
      open: true,
      contextType: 'session',
      contextId: 'parent-session-1',
      roomId: null,
      threads: [],
      activeThreadId: null,
      messages: [],
      isStreaming: false,
      pendingQuestion: null,
      loading: false,
    });

    render(<AiPanel />);

    expect(await screen.findByText('Ask AI anything about this session')).toBeInTheDocument();
    expect(screen.getByText('Summarize the entire conversation in this session.')).toBeInTheDocument();
    expect(screen.getByText('List the decisions and remaining TODOs from this session.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions?parentSessionId=parent-session-1&includeProject=1', expect.any(Object));
    expect(fetchMock).not.toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'POST' }));
    expect(useAiPanelStore.getState().activeThreadId).toBeNull();
  });

  it('creates a persisted thread only when the first draft message is sent', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/sessions?')) return { ok: true, json: async () => [] };
      if (url === '/api/sessions' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            id: 'auto-thread-1',
            name: 'New thread',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        };
      }
      return { ok: true, json: async () => [] };
    });

    useAiPanelStore.setState({
      open: true,
      contextType: 'session',
      contextId: 'parent-session-1',
      roomId: null,
      threads: [],
      activeThreadId: null,
      messages: [],
      isStreaming: false,
      pendingQuestion: null,
      loading: false,
    });

    render(<AiPanel />);

    const sample = await screen.findByText('Summarize the entire conversation in this session.');
    fireEvent.click(sample);
    const input = screen.getByPlaceholderText('Ask AI...') as HTMLTextAreaElement;
    expect(input.value).toBe('Summarize the entire conversation in this session.');

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => {
      expect(useAiPanelStore.getState().activeThreadId).toBe('auto-thread-1');
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'POST' }));
    expect((window as any).__towerWs.send).toHaveBeenCalledWith(expect.stringContaining('auto-thread-1'));
  });

  it('does not create a draft thread when threads already exist', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/sessions?')) {
        return {
          ok: true,
          json: async () => [{
            id: 'existing-thread-1',
            name: 'Existing thread',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            aiPanelScope: 'session',
          }],
        };
      }
      return { ok: true, json: async () => [] };
    });

    useAiPanelStore.setState({
      open: true,
      contextType: 'session',
      contextId: 'parent-session-1',
      roomId: null,
      threads: [],
      activeThreadId: null,
      messages: [],
      isStreaming: false,
      pendingQuestion: null,
      loading: false,
    });

    render(<AiPanel />);

    await waitFor(() => expect(screen.getByText('Existing thread')).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'POST' }));
  });

  it('lists parent-session agent threads before project-level AI panel threads only', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/sessions?')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'agent-thread-1',
              name: 'Research agent',
              label: 'agent',
              aiPanelScope: 'session',
              parentSessionId: 'parent-session-1',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: 'my-project-thread-1',
              name: 'My other session thread',
              label: 'ai_thread',
              aiPanelScope: 'project',
              parentSessionId: 'other-parent-session',
              projectId: 'project-1',
              visibility: 'private',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: 'project-thread-1',
              name: 'Project discussion',
              label: 'project_ai',
              aiPanelScope: 'project',
              projectId: 'project-1',
              visibility: 'project',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        };
      }
      return { ok: true, json: async () => [] };
    });

    useAiPanelStore.setState({
      open: true,
      contextType: 'session',
      contextId: 'parent-session-1',
      roomId: null,
      threads: [],
      activeThreadId: null,
      messages: [],
      isStreaming: false,
      pendingQuestion: null,
      loading: false,
    });
    useSessionStore.setState({
      activeSessionId: 'parent-session-1',
      sessions: [{ id: 'parent-session-1', name: 'Parent', projectId: 'project-1' } as any],
      isMobile: false,
    } as any);

    render(<AiPanel />);

    expect(await screen.findByText('Research agent')).toBeInTheDocument();
    expect(screen.getByText('My other session thread')).toBeInTheDocument();
    expect(screen.getByText('Project discussion')).toBeInTheDocument();
    expect(screen.getAllByText('agent').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('project').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('local')).toBeInTheDocument();
    expect(screen.getByText('mine')).toBeInTheDocument();
    expect(screen.getByText('shared')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions?parentSessionId=parent-session-1&includeProject=1', expect.any(Object));
  });
});

describe('AiPanel stop control', () => {
  it('sends the real abort command for the active panel thread', async () => {
    useAiPanelStore.setState({
      open: true,
      contextType: 'session',
      contextId: 'parent-session-1',
      roomId: null,
      threads: [{
        id: 'thread-stop-1',
        name: 'Running thread',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any],
      activeThreadId: 'thread-stop-1',
      messages: [],
      isStreaming: true,
      pendingQuestion: null,
      loading: false,
    });

    render(<AiPanel />);

    const stopButton = await screen.findByRole('button', { name: 'Stop AI panel response' });
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    fireEvent.click(stopButton);

    expect((window as any).__towerWs.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'abort',
      sessionId: 'thread-stop-1',
    }));
    expect(useAiPanelStore.getState().isStreaming).toBe(false);
  });
});

describe('AiPanel thread deletion', () => {
  it('deletes a listed thread after inline confirmation', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/sessions?')) {
        return {
          ok: true,
          json: async () => [{
            id: 'thread-delete-1',
            name: 'Delete me',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
        };
      }
      if (url === '/api/sessions/thread-delete-1' && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => [] };
    });

    useAiPanelStore.setState({
      open: true,
      contextType: 'session',
      contextId: 'parent-session-1',
      roomId: null,
      threads: [],
      activeThreadId: null,
      messages: [],
      isStreaming: false,
      pendingQuestion: null,
      loading: false,
    });

    render(<AiPanel />);

    expect(await screen.findByText('Delete me')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete thread Delete me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete thread Delete me' }));

    await waitFor(() => expect(screen.queryByText('Delete me')).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/thread-delete-1', expect.objectContaining({ method: 'DELETE' }));
    expect(useAiPanelStore.getState().threads).toHaveLength(0);
  });

  it('returns to draft view when the last listed thread is deleted', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/sessions?')) {
        return {
          ok: true,
          json: async () => [{
            id: 'thread-active-1',
            name: 'Active thread',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
        };
      }
      if (url === '/api/sessions/thread-active-1' && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (url === '/api/sessions/thread-active-1/messages') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => [] };
    });

    useAiPanelStore.setState({
      open: true,
      contextType: 'session',
      contextId: 'parent-session-1',
      roomId: null,
      threads: [],
      activeThreadId: null,
      messages: [],
      isStreaming: false,
      pendingQuestion: null,
      loading: false,
    });

    render(<AiPanel />);

    expect(await screen.findByText('Active thread')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete thread Active thread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete thread Active thread' }));

    await waitFor(() => expect(useAiPanelStore.getState().threads).toHaveLength(0));
    expect(screen.getByText('Ask AI anything about this session')).toBeInTheDocument();
  });
});

describe('AiPanel width resize', () => {
  it('uses persisted desktop width and saves dragged width', async () => {
    localStorage.setItem('tower:ai-panel:width', '520');
    useAiPanelStore.setState({
      open: true,
      contextType: 'session',
      contextId: 'parent-session-1',
      roomId: null,
      threads: [{
        id: 'thread-1',
        name: 'Thread 1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any],
      activeThreadId: 'thread-1',
      messages: [],
      isStreaming: false,
      pendingQuestion: null,
      loading: false,
    });

    const { container } = render(<AiPanel />);
    const panel = container.querySelector('[style*="width: 520px"]');
    expect(panel).toBeInTheDocument();

    const handle = container.querySelector('[aria-label="Resize panel"]') as HTMLElement;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 800 });
    fireEvent.pointerMove(document, { clientX: window.innerWidth - 640 });
    fireEvent.pointerUp(document);

    await waitFor(() => {
      expect(localStorage.getItem('tower:ai-panel:width')).toBe('640');
    });
  });
});
