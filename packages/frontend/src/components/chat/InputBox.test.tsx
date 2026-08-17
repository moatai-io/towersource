// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { act } from 'react';
import { InputBox } from './InputBox';
import { useChatStore } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  useChatStore.setState({
    isStreaming: false,
    sessionId: null,
    engineSessionId: null,
    messages: [],
    slashCommands: [],
    attachments: [],
    messageQueue: {},
    pendingInjections: {},
  });
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    streamingSessions: new Set(),
    unreadSessions: new Set(),
    sidebarOpen: true,
    sidebarTab: 'sessions',
    searchQuery: '',
    isMobile: false,
    mobileTab: 'ai',
    mobileContextOpen: false,
    mobileTabBeforeContext: 'ai',
    activeView: 'chat',
  });

  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('tower:inputDraft')) toRemove.push(key);
  }
  toRemove.forEach((k) => localStorage.removeItem(k));
  vi.unstubAllGlobals();
  delete (window as any).__towerWs;
});

describe('InputBox quick replies', () => {
  it('shows quick reply buttons on desktop when the composer is empty', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '무엇을 도와드릴까요?' }],
        timestamp: Date.now(),
      }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    expect(screen.getByText('계속 진행')).toBeInTheDocument();
    expect(screen.getByText('쉽게 설명')).toBeInTheDocument();
    expect(screen.getByText('결정 저장')).toBeInTheDocument();

    fireEvent.click(screen.getByText('계속 진행'));

    expect(onSend).toHaveBeenCalledWith('계속 진행해줘');
  });

  it('fills the ghost suggestion with Tab without sending it', async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestion: '계속 진행하자' }),
    }));

    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: '이 방식의 비용 차이는 어떻게 돼?' }],
        timestamp: Date.now() - 1,
      }, {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '다음 단계 구현을 진행할 수 있습니다.' }],
        timestamp: Date.now(),
      }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    render(<InputBox onSend={onSend} onAbort={onAbort} />);
    const textarea = screen.getByLabelText('메시지 입력') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.placeholder).toBe('계속 진행하자'));
    expect(screen.getByText('계속 진행')).toBeInTheDocument();
    const fetchMock = vi.mocked(fetch);
    const suggestionCall = fetchMock.mock.calls.find(([url]) => url === '/api/ai/reply-suggestion');
    const request = JSON.parse(String(suggestionCall?.[1]?.body));
    expect(request.assistantTail).toBe('다음 단계 구현을 진행할 수 있습니다.');
    fireEvent.keyDown(textarea, { key: 'Tab' });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('계속 진행하자');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('계속 진행하자');
  });

  it.skip('requests a draft completion after a short typing pause and fills the suffix with Tab', async () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestion: '', suffix: ' 비용도 비교해줘' }),
    }));
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '두 가지 구현 방식이 있습니다.' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    const textarea = screen.getByLabelText('메시지 입력') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '성능 차이랑' } });
    await act(async () => { vi.advanceTimersByTime(499); });
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai/reply-suggestion')).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText((_, node) => node?.textContent === ' 비용도 비교해줘')).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: 'Tab' });

    expect(textarea.value).toBe('성능 차이랑 비용도 비교해줘');
    expect(onSend).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it.skip('sends the exact current draft, including trailing cursor space, for inline completion', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestion: '', suffix: '모바일에서도 확인해줘' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '모바일 완성 버튼을 구현했습니다.' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    const textarea = screen.getByLabelText('메시지 입력') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '그 기능을 ' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await Promise.resolve(); });

    const suggestionCall = fetchMock.mock.calls.find(([url]) => url === '/api/ai/reply-suggestion');
    expect(JSON.parse(String(suggestionCall?.[1]?.body)).draft).toBe('그 기능을 ');
    expect(screen.getByText((_, node) => node?.textContent === '모바일에서도 확인해줘')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it.skip('preserves a leading space required between the draft and suffix', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestion: '', suffix: ' 비용도 비교해줘' }),
    }));
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '비용도 비교할 수 있습니다.' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    const textarea = screen.getByLabelText('메시지 입력') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '성능 차이랑' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(textarea, { key: 'Tab' });

    expect(textarea.value).toBe('성능 차이랑 비용도 비교해줘');
    vi.useRealTimers();
  });

  it.skip('shows suffix-only model responses after the user pauses typing', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestion: '', suffix: ' 비용도 비교해줘' }),
    }));
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '성능과 비용을 비교할 수 있습니다.' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    const textarea = screen.getByLabelText('메시지 입력') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '성능 차이랑' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText((_, node) => node?.textContent === ' 비용도 비교해줘')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it.skip('restarts the short debounce after edits and ignores the cancelled request', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return Promise.resolve({ ok: true, json: async () => ({ suggestion: '', suffix: ' 완성' }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '비교할 수 있습니다.' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    const textarea = screen.getByLabelText('메시지 입력') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '첫 문장' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await Promise.resolve(); });
    const firstSuggestionCall = fetchMock.mock.calls.findIndex(([url]) => url === '/api/ai/reply-suggestion');
    expect(firstSuggestionCall).toBeGreaterThanOrEqual(0);

    fireEvent.change(textarea, { target: { value: '수정한 문장' } });
    expect(signals[firstSuggestionCall]?.aborted).toBe(true);
    await act(async () => { vi.advanceTimersByTime(4_999); });
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/ai/reply-suggestion')).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/ai/reply-suggestion')).toHaveLength(2);
    vi.useRealTimers();
  });

  it.skip('does not immediately re-request after accepting a completion with Tab', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ suggestion: '', suffix: ' 비용도 비교해줘' }) });
    vi.stubGlobal('fetch', fetchMock);
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '두 방식이 있습니다.' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    const textarea = screen.getByLabelText('메시지 입력') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '성능 차이랑' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(textarea, { key: 'Tab' });
    await act(async () => { vi.advanceTimersByTime(1_501); });

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/ai/reply-suggestion')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('lets mobile users explicitly fill a ghost suggestion without sending it', async () => {
    const onSend = vi.fn();
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 640px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestion: '계속 진행하자', suffix: '' }),
    }));
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '진행할까요?' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: true, streamingSessions: new Set() });

    render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    const textarea = screen.getByLabelText('메시지 입력') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.placeholder).toBe('계속 진행하자'));

    fireEvent.click(screen.getByRole('button', { name: '자동완성 제안 채우기' }));

    expect(textarea.value).toBe('계속 진행하자');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '자동완성 제안 채우기' })).not.toBeInTheDocument();
  });

  it('removes the ghost suggestion as soon as the user types', async () => {
    vi.useRealTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestion: '계속 진행하자' }),
    }));
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '진행할까요?' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    const textarea = screen.getByLabelText('메시지 입력') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.placeholder).toBe('계속 진행하자'));
    fireEvent.change(textarea, { target: { value: '내가 직접 쓸게' } });

    expect(textarea.value).toBe('내가 직접 쓸게');
    expect(textarea.placeholder).toBe('Type a message...');
  });

  it('allows a visible quick reply to be used again after a fast completed turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'));
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '첫 번째 응답' }],
        timestamp: Date.now(),
      }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', isMobile: false, streamingSessions: new Set() });

    const { rerender } = render(<InputBox onSend={onSend} onAbort={onAbort} />);
    fireEvent.click(screen.getByText('계속 진행'));

    vi.advanceTimersByTime(2_100);
    useChatStore.setState({
      messages: [
        ...useChatStore.getState().messages,
        {
          id: 'a2',
          role: 'assistant',
          content: [{ type: 'text', text: '두 번째 응답' }],
          timestamp: Date.now(),
        },
      ],
    });
    rerender(<InputBox onSend={onSend} onAbort={onAbort} />);
    fireEvent.click(screen.getByText('계속 진행'));

    expect(onSend).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not request autocomplete before a four-character draft is present', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: async () => url.startsWith('/api/commands') ? [] : {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '진행할까요?' }], timestamp: Date.now() }],
      attachments: [],
    });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('메시지 입력'), { target: { value: '세 글' } });
    await new Promise((resolve) => setTimeout(resolve, 1_600));

    expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai/reply-suggestion')).toBe(false);
  });
});

describe('InputBox slash command picker', () => {
  it('prioritizes command name matches over description matches', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      slashCommands: [
        { name: 'skill-architect', description: 'agent workflow를 설계하는 스킬', source: 'skills', scope: 'company' },
        { name: 'agent', canonical: 'agent', description: '프로젝트 에이전트', source: 'workflow', scope: 'system', kind: 'workflow' },
      ],
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/age' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('/agent ');
  });

  it('marks picker-selected commands with picker trigger when sent', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      slashCommands: [
        { name: 'skill-architect', description: 'agent workflow를 설계하는 스킬', source: 'skills', scope: 'company', kind: 'skill' },
      ],
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/skill' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    fireEvent.change(textarea, { target: { value: '/skill-architect 새 스킬 만들어' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('/skill-architect 새 스킬 만들어', { commandTrigger: 'picker' });
  });

  it('keeps picker open at an exact command until whitespace commits the command head', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      slashCommands: [
        { name: 'agent', canonical: 'agent', description: '프로젝트 에이전트', source: 'workflow', scope: 'system', kind: 'workflow' },
        { name: 'skill-architect', description: 'agent workflow를 설계하는 스킬', source: 'skills', scope: 'company' },
      ],
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/agent' } });
    expect(screen.getByText('agent')).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('/agent ');

    fireEvent.change(textarea, { target: { value: '/agent reviewer diff 봐줘' } });
    expect(screen.queryByText('skill-architect')).not.toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('/agent reviewer diff 봐줘', { commandTrigger: 'picker' });
  });
});

describe('InputBox queue + session isolation', () => {
  it('keeps per-session drafts isolated across rapid switches', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: false, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 's1 draft' } });
    expect(localStorage.getItem('tower:inputDraft:s1')).toBe('s1 draft');

    act(() => {
      useChatStore.setState({ sessionId: 's2' });
      useSessionStore.setState({ activeSessionId: 's2' });
    });
    fireEvent.change(textarea, { target: { value: 's2 draft' } });
    expect(localStorage.getItem('tower:inputDraft:s2')).toBe('s2 draft');

    act(() => {
      useChatStore.setState({ sessionId: 's1' });
      useSessionStore.setState({ activeSessionId: 's1' });
    });
    expect(textarea.value).toBe('s1 draft');
    expect(localStorage.getItem('tower:inputDraft:s1')).toBe('s1 draft');
    expect(localStorage.getItem('tower:inputDraft:s2')).toBe('s2 draft');
  });

  it('requests the latest turn when revisiting a session with an unfinished draft', async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const onDraftRestored = vi.fn();
    window.addEventListener('tower-composer-draft-restored', onDraftRestored);

    useChatStore.setState({ isStreaming: false, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'unfinished draft' } });

    act(() => {
      useChatStore.setState({ sessionId: 's2' });
      useSessionStore.setState({ activeSessionId: 's2' });
    });
    act(() => {
      useChatStore.setState({ sessionId: 's1' });
      useSessionStore.setState({ activeSessionId: 's1' });
    });

    await waitFor(() => expect(onDraftRestored).toHaveBeenCalled());
    expect((onDraftRestored.mock.calls.at(-1)?.[0] as CustomEvent).detail).toEqual({ sessionId: 's1' });
    window.removeEventListener('tower-composer-draft-restored', onDraftRestored);
  });

  it('clears queued message when session changes', async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: true, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(['s1']) });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i);
    fireEvent.change(textarea, { target: { value: 'queued msg' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    act(() => {
      useChatStore.setState({ sessionId: 's2' });
      useSessionStore.setState({ activeSessionId: 's2', streamingSessions: new Set() });
    });

    act(() => {
      useChatStore.setState({ isStreaming: false });
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('auto-sends queued message when session streaming ends', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: true, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(['s1']) });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i);
    fireEvent.change(textarea, { target: { value: 'my message' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    act(() => {
      useChatStore.setState({ isStreaming: false });
      useSessionStore.setState({ streamingSessions: new Set() });
    });

    expect(onSend).toHaveBeenCalledWith('my message');
  });

  it('sends immediately as steering when the active streaming session uses a Pi model', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: true, sessionId: 's1' });
    useSessionStore.setState({
      activeSessionId: 's1',
      streamingSessions: new Set(['s1']),
      sessions: [{
        id: 's1', name: 'Pi session', cwd: '/tmp/test', tags: [], favorite: false,
        totalCost: 0, totalTokens: 0, createdAt: '2026-05-18T00:00:00Z', updatedAt: '2026-05-18T00:00:00Z',
        modelUsed: 'azure-openai-responses-eastus2/gpt-5.5',
      }],
    });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|끼어들/i);
    fireEvent.change(textarea, { target: { value: 'steer now' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('steer now');
    expect(useChatStore.getState().messageQueue['s1']).toBeUndefined();
  });

  it('ignores Enter key auto-repeat so provider fast-fail cannot inject a loop', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: false, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i);
    fireEvent.change(textarea, { target: { value: 'same prompt' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false, repeat: false });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false, repeat: true });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false, repeat: true });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('same prompt');
  });

  it('dedupes identical rapid submissions even if the textarea has not repainted yet', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: false, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i);
    fireEvent.change(textarea, { target: { value: 'same prompt' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('drops queued message when streaming ends but session differs', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: true, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(['s1']) });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i);
    fireEvent.change(textarea, { target: { value: 'stale msg' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    act(() => {
      useChatStore.setState({ isStreaming: false, sessionId: 's2' });
      useSessionStore.setState({ activeSessionId: 's2', streamingSessions: new Set() });
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('drops queued message after rapid session switches (s1→s2→s3→s4)', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: true, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(['s1']) });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i);
    fireEvent.change(textarea, { target: { value: 'rapid msg' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    act(() => {
      useChatStore.setState({ sessionId: 's2' });
      useSessionStore.setState({ activeSessionId: 's2' });
    });
    act(() => {
      useChatStore.setState({ sessionId: 's3' });
      useSessionStore.setState({ activeSessionId: 's3' });
    });
    act(() => {
      useChatStore.setState({ sessionId: 's4', isStreaming: false });
      useSessionStore.setState({ activeSessionId: 's4', streamingSessions: new Set() });
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('cancels queued message on Escape key press', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: true, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(['s1']) });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i);
    fireEvent.change(textarea, { target: { value: 'cancel me' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    fireEvent.keyDown(textarea, { key: 'Escape' });

    act(() => {
      useChatStore.setState({ isStreaming: false });
      useSessionStore.setState({ streamingSessions: new Set() });
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('hides a pending Pi steer chip if the same message is already in transcript', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({
      sessionId: 's1',
      messages: [{
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: '이미 버블로 보이는 steer' }],
        timestamp: Date.now(),
        sendStatus: 'delivered',
      }],
      pendingInjections: { s1: [{ id: 'm1', text: '이미 버블로 보이는 steer' }] },
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(['s1']) });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    expect(screen.queryByLabelText('전달 대기 중인 Pi 끼어들기 메시지')).not.toBeInTheDocument();
  });

  it('shows pending Pi steer chips with a cancel action', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({
      sessionId: 's1',
      pendingInjections: { s1: [{ id: 'm1', text: '추가 지시' }] },
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(['s1']) });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    expect(screen.getByText('추가 지시')).toBeInTheDocument();
    expect(screen.queryByText('AI 반영 대기')).not.toBeInTheDocument();
    const send = vi.fn();
    (window as any).__towerWs = { readyState: WebSocket.OPEN, send };

    fireEvent.click(screen.getByLabelText('전달 대기 메시지 취소'));

    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: 'cancel_steer', sessionId: 's1', messageId: 'm1' }));
    expect(useChatStore.getState().pendingInjections['s1']).toHaveLength(1);
  });

  it('uploads dropped CSV files as file references instead of inlining contents', async () => {
    const onSend = vi.fn();
    useChatStore.setState({ sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1' });
    const onAbort = vi.fn();
    class FakeXMLHttpRequest {
      static last: FakeXMLHttpRequest | null = null;
      status = 200;
      response: any = null;
      responseText = '';
      responseType = '';
      uploadListeners: Record<string, Array<(event: any) => void>> = {};
      listeners: Record<string, Array<() => void>> = {};
      upload = { addEventListener: (name: string, listener: (event: any) => void) => {
        (this.uploadListeners[name] ||= []).push(listener);
      } };
      open = vi.fn();
      setRequestHeader = vi.fn();
      addEventListener = (name: string, listener: () => void) => { (this.listeners[name] ||= []).push(listener); };
      send = vi.fn(() => {
        this.uploadListeners.progress?.forEach(listener => listener({ lengthComputable: true, loaded: 17, total: 17 }));
        this.uploadListeners.load?.forEach(listener => listener({}));
        this.response = {
          attachments: [{
            id: '11111111-1111-4111-8111-111111111111',
            name: 'sample.csv',
            uri: 'session://attachments/11111111-1111-4111-8111-111111111111',
            sizeBytes: 17,
            mimeType: 'text/csv',
            expiresAt: '2026-07-17T00:00:00.000Z',
          }],
        };
        this.listeners.load?.forEach(listener => listener());
      });
      constructor() { FakeXMLHttpRequest.last = this; }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);

    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i);
    const file = new File(['a,b\n1,2\n3,4'], 'sample.csv', { type: 'text/csv' });
    fireEvent.drop(textarea, {
      dataTransfer: {
        getData: () => '',
        files: [file],
      },
    });

    await waitFor(() => expect(FakeXMLHttpRequest.last?.open).toHaveBeenCalledWith('POST', '/api/session-attachments/s1'));
    await waitFor(() => {
      expect(useChatStore.getState().attachments).toEqual([
        expect.objectContaining({
          type: 'file',
          label: 'sample.csv',
          content: 'session://attachments/11111111-1111-4111-8111-111111111111',
          sessionAttachmentId: '11111111-1111-4111-8111-111111111111',
        }),
      ]);
    });
    expect(useChatStore.getState().attachments[0]?.content).not.toContain('a,b');
  });

  it('flushes stale Pi steer chips into delivered bubbles once the session is idle', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({
      sessionId: 's1',
      messages: [],
      pendingInjections: { s1: [{ id: 'm1', text: '이미 처리된 steer' }] },
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    expect(screen.queryByText('이미 처리된 steer')).not.toBeInTheDocument();
    expect(useChatStore.getState().pendingInjections['s1']).toBeUndefined();
    expect(useChatStore.getState().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'm1',
        role: 'user',
        sendStatus: 'delivered',
        content: [{ type: 'text', text: '이미 처리된 steer' }],
      }),
    ]));
  });

  it('periodically asks the server to verify a pure stale streaming session', () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const send = vi.fn();
    (window as any).__towerWs = { readyState: WebSocket.OPEN, send };

    useChatStore.setState({ isStreaming: true, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(['s1']) });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: 'check_session_status', sessionId: 's1' }));
    vi.useRealTimers();
  });

  it('shows send UI when only the stale global flag is true', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    useChatStore.setState({ isStreaming: true, sessionId: 's1' });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    expect(screen.queryByTitle('Stop')).not.toBeInTheDocument();
    expect(screen.getByTitle('Send')).toBeInTheDocument();
  });

  it('sends the controlled input when the arrow button is clicked', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i);
    fireEvent.change(textarea, { target: { value: '화살표 버튼으로 전송' } });
    fireEvent.click(screen.getByTitle('Send'));

    expect(onSend).toHaveBeenCalledWith('화살표 버튼으로 전송');
  });

  it('keeps pasted text in the controlled draft so the arrow button can send immediately', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i) as HTMLTextAreaElement;
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [],
        getData: (type: string) => type === 'text/plain' ? '버튼으로 바로 보낼 복붙 글' : '',
      },
    });

    expect(textarea.value).toBe('버튼으로 바로 보낼 복붙 글');

    fireEvent.click(screen.getByTitle('Send'));

    expect(onSend).toHaveBeenCalledWith('버튼으로 바로 보낼 복붙 글');
  });

  it('submits the textarea DOM value when paste/input state has not committed before Enter', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    render(<InputBox onSend={onSend} onAbort={onAbort} />);

    const textarea = screen.getByPlaceholderText(/Type a message|send on the next turn/i) as HTMLTextAreaElement;
    // Simulate a browser paste/input ordering where the DOM is current but the
    // controlled React state is still from the previous render.
    textarea.value = '복붙 직후 바로 보내는 글';
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('복붙 직후 바로 보내는 글');
  });

  it('answers AskUserQuestion from the regular input while awaiting_user', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const onAnswerQuestion = vi.fn();

    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      pendingQuestion: {
        questionId: 'q-1',
        sessionId: 's1',
        questions: [{ question: '확인할까요?', options: [] }],
      },
      turnStateBySession: {
        s1: {
          phase: 'awaiting_user',
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          pendingMessageCount: 0,
          pendingQuestionId: 'q-1',
        },
      },
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={onAbort} onAnswerQuestion={onAnswerQuestion} />);

    const textarea = screen.getByPlaceholderText(/질문에 답변|답변 입력/i);
    fireEvent.change(textarea, { target: { value: '네' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
    expect(onAnswerQuestion).toHaveBeenCalledWith('q-1', '네');
  });
});
