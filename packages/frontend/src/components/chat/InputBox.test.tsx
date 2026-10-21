// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { act } from 'react';
import { InputBox } from './InputBox';
import { useSessionWelcome } from '../../features/session-welcome/useSessionWelcome';
import { ATTACH_COMPOSER_SOURCE_EVENT, type AttachComposerSourceDetail } from '../files/source-inspector/sourceReference';
import { useChatStore } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';
import i18n from '../../i18n';

beforeEach(async () => {
  await i18n.changeLanguage('en');
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
    cost: { totalCost: 0, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0, contextInputTokens: 0, contextOutputTokens: 0, contextWindowSize: 0, contextEstimatedTokens: 0 },
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
    if (key?.startsWith('tower:inputDraft') || key?.startsWith('tower:contextHandoffDismissed:')) toRemove.push(key);
  }
  toRemove.forEach((k) => localStorage.removeItem(k));
  vi.unstubAllGlobals();
  delete (window as any).__towerWs;
});

describe('InputBox high context usage', () => {
  it('does not suggest a handoff when the context display reaches 87%', () => {
    const onSend = vi.fn();
    useChatStore.setState({
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Still working.' }], timestamp: Date.now() }],
      cost: { ...useChatStore.getState().cost, contextInputTokens: 174_000, contextWindowSize: 200_000 },
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    expect(screen.queryByTestId('context-handoff-prompt')).not.toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('InputBox quick replies', () => {
  it('hides floating quick replies during streaming so they cannot cover the active-turn status', () => {
    useChatStore.setState({
      isStreaming: true,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Working' }], timestamp: Date.now() }],
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(['s1']) });
    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    expect(screen.queryByTestId('floating-quick-replies')).not.toBeInTheDocument();
    act(() => {
      useChatStore.setState({ isStreaming: false });
      useSessionStore.setState({ streamingSessions: new Set() });
    });
    expect(screen.getByTestId('floating-quick-replies')).toBeInTheDocument();
  });

  it('shows fallback actions when the composer is empty', () => {
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

    expect(screen.getByText('Continue')).toBeInTheDocument();
    expect(screen.getByTestId('floating-composer-companions')).toHaveClass('absolute', 'bottom-full', 'pointer-events-none', 'bg-transparent');
    expect(screen.getByTestId('floating-quick-replies').parentElement).toBe(screen.getByTestId('floating-composer-companions'));
    expect(screen.getByText('Continue').closest('button')).toHaveClass('pointer-events-auto');
    expect(screen.queryByText('Prepare handoff')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Continue'));

    expect(onSend).toHaveBeenCalledWith('Continue');
  });

  it('uses server-provided human-only actions without AI ranking', async () => {
    const onSend = vi.fn();
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: async () => url.startsWith('/api/sessions/s1/composer-actions')
        ? {
            contextRevision: 7,
            mode: 'guide',
            source: 'tower_rule',
            recommendedActionId: null,
            actions: [
              { id: 'continue', contextRevision: 7, label: 'Continue', message: 'Continue with the current plan', intent: 'continue', risk: 'reversible', origin: 'tower_rule', autoEligible: false },
              { id: 'replan', contextRevision: 7, label: 'Prepare handoff', message: 'Prepare a concise handoff with relevant files and recommended skills', intent: 'replan', risk: 'reversible', origin: 'tower_rule', autoEligible: false },
            ],
            autoMode: { available: false, status: 'coming_soon' },
          }
        : [],
    })));
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Implementation complete.' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });

    render(<InputBox onSend={onSend} onAbort={vi.fn()} />);

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('/api/sessions/s1/composer-actions'),
      expect.any(Object),
    ));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Prepare handoff' })).not.toBeInTheDocument();
    expect(screen.queryByText(/AI \d+%/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('jev-review-status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onSend).toHaveBeenCalledWith('Continue with the current plan');
  });

  it('keeps fallback actions when the dynamic action endpoint is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({ ok: false, json: async () => url.startsWith('/api/commands') ? [] : {} })));
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], timestamp: Date.now() }],
      attachments: [],
    });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Continue')).toBeInTheDocument());
    expect(screen.queryByText('Prepare handoff')).not.toBeInTheDocument();
  });

  it.skip('fills the ghost suggestion with Tab without sending it', async () => {
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
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.placeholder).toBe('계속 진행하자'));
    expect(screen.getByText('Continue')).toBeInTheDocument();
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
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
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
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
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
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
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
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
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
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
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
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '성능 차이랑' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(textarea, { key: 'Tab' });
    await act(async () => { vi.advanceTimersByTime(1_501); });

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/ai/reply-suggestion')).toHaveLength(1);
    vi.useRealTimers();
  });

  it.skip('lets mobile users explicitly fill a ghost suggestion without sending it', async () => {
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
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.placeholder).toBe('계속 진행하자'));

    fireEvent.click(screen.getByRole('button', { name: '자동완성 제안 채우기' }));

    expect(textarea.value).toBe('계속 진행하자');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '자동완성 제안 채우기' })).not.toBeInTheDocument();
  });

  it.skip('removes the ghost suggestion as soon as the user types', async () => {
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
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
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
    fireEvent.click(screen.getByText('Continue'));

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
    fireEvent.click(screen.getByText('Continue'));

    expect(onSend).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not request autocomplete for empty or non-empty drafts while the kill switch is off', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 600));
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: '작성 중인 문장' } });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai/composer-settings')).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai/reply-suggestion')).toBe(false);
  });
});

describe('InputBox source references', () => {
  it('shows an exact source chip and includes the trusted source block when sent', () => {
    const onSend = vi.fn();
    useChatStore.setState({ isStreaming: false, sessionId: 's1', attachments: [] });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={onSend} onAbort={vi.fn()} />);

    const detail: AttachComposerSourceDetail = {
      reference: {
        version: 1,
        id: 'final/site/index.html:10:31',
        path: 'final/site/index.html',
        language: 'html',
        kind: 'element',
        tagName: 'button',
        start: 10,
        end: 31,
        lineStart: 4,
        lineEnd: 4,
        source: '<button>Buy</button>',
        confidence: 'exact',
        mappingProvider: 'html-parser',
      },
    };
    act(() => {
      window.dispatchEvent(new CustomEvent(ATTACH_COMPOSER_SOURCE_EVENT, { detail }));
    });

    expect(screen.getByText(/<button> · final\/site\/index\.html:L4–L4/)).toBeInTheDocument();
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Make this CTA shorter.' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledTimes(1);
    const message = onSend.mock.calls[0][0] as string;
    expect(message).toBe('Make this CTA shorter.');
    expect(message).not.toContain('<tower_source_reference_json>');
    expect(onSend.mock.calls[0][1]).toEqual({ sourceReference: detail.reference });
    expect(screen.queryByText(/<button> · final\/site\/index\.html:L4–L4/)).not.toBeInTheDocument();
  });

  it('consumes the source chip on send and does not restore it after a no-change result', () => {
    const reference: AttachComposerSourceDetail['reference'] = {
      version: 1, id: 'index.html:10:31', path: 'index.html', language: 'html', kind: 'element',
      tagName: 'button', start: 10, end: 31, lineStart: 4, lineEnd: 4,
      source: '<button>Buy</button>', confidence: 'exact', mappingProvider: 'html-parser',
    };
    useChatStore.setState({ isStreaming: false, sessionId: 's1', attachments: [], messages: [] });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    const onSend = vi.fn();
    const { rerender } = render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    act(() => window.dispatchEvent(new CustomEvent(ATTACH_COMPOSER_SOURCE_EVENT, { detail: { reference } })));
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: '버튼을 짧게 바꿔줘' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(screen.queryByText(/<button> · index\.html:L4–L4/)).not.toBeInTheDocument();
    useChatStore.setState({ messages: [{
      id: 'a1', role: 'assistant', content: [{ type: 'text', text: '변경하지 않았습니다.' }],
      metadata: { sourceType: 'scoped_edit_result', sourceReferenceId: reference.id, applied: false },
    }] });
    rerender(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    expect(screen.queryByText(/<button> · index\.html:L4–L4/)).not.toBeInTheDocument();
  });

  it('does not restore the source chip after a hard scoped-edit error', () => {
    const reference: AttachComposerSourceDetail['reference'] = {
      version: 1, id: 'index.html:10:31', path: 'index.html', language: 'html', kind: 'element',
      tagName: 'button', start: 10, end: 31, lineStart: 4, lineEnd: 4,
      source: '<button>Buy</button>', confidence: 'exact', mappingProvider: 'html-parser',
    };
    useChatStore.setState({ isStreaming: false, sessionId: 's1', attachments: [], messages: [] });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    const onSend = vi.fn();
    const { rerender } = render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    act(() => window.dispatchEvent(new CustomEvent(ATTACH_COMPOSER_SOURCE_EVENT, { detail: { reference } })));
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: '버튼을 바꿔줘' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(screen.queryByText(/<button> · index\.html:L4–L4/)).not.toBeInTheDocument();

    useChatStore.setState({ messages: [{
      id: 'a1', role: 'assistant', content: [{ type: 'text', text: '수정하지 못했습니다.' }],
      metadata: {
        sourceType: 'scoped_edit_result', sourceReferenceId: reference.id, applied: false,
        error: 'scoped_edit_worker_cas_unavailable',
      },
    }] });
    rerender(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    expect(screen.queryByText(/<button> · index\.html:L4–L4/)).not.toBeInTheDocument();
  });

  it('does not consume a reattached chip from a historical success for the same reference', () => {
    const reference: AttachComposerSourceDetail['reference'] = {
      version: 1, id: 'index.html:10:31', path: 'index.html', language: 'html', kind: 'element',
      tagName: 'button', start: 10, end: 31, lineStart: 4, lineEnd: 4,
      source: '<button>Buy</button>', confidence: 'exact', mappingProvider: 'html-parser',
    };
    useChatStore.setState({ isStreaming: false, sessionId: 's1', attachments: [], messages: [{
      id: 'old-success', role: 'assistant', content: [{ type: 'text', text: '예전에 수정했습니다.' }],
      metadata: { sourceType: 'scoped_edit_result', sourceReferenceId: reference.id, applied: true },
    }] });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    act(() => window.dispatchEvent(new CustomEvent(ATTACH_COMPOSER_SOURCE_EVENT, { detail: { reference } })));
    expect(screen.getByText(/<button> · index\.html:L4–L4/)).toBeInTheDocument();
  });

  it('does not consume a newer source chip when an older reference succeeds', () => {
    const oldReference: AttachComposerSourceDetail['reference'] = {
      version: 1, id: 'index.html:1:5', path: 'index.html', language: 'html', kind: 'element', tagName: 'h1',
      start: 1, end: 5, lineStart: 1, lineEnd: 1, source: '<h1>x</h1>', confidence: 'exact', mappingProvider: 'html-parser',
    };
    const newReference = { ...oldReference, id: 'index.html:10:20', tagName: 'p', start: 10, end: 20, lineStart: 2, lineEnd: 2, source: '<p>y</p>' };
    useChatStore.setState({ isStreaming: false, sessionId: 's1', attachments: [], messages: [] });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set() });
    const { rerender } = render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    act(() => window.dispatchEvent(new CustomEvent(ATTACH_COMPOSER_SOURCE_EVENT, { detail: { reference: newReference } })));
    useChatStore.setState({ messages: [{
      id: 'a1', role: 'assistant', content: [{ type: 'text', text: '수정했습니다.' }],
      metadata: { sourceType: 'scoped_edit_result', sourceReferenceId: oldReference.id, applied: true },
    }] });
    rerender(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    expect(screen.getByText(/<p> · index\.html:L2–L2/)).toBeInTheDocument();
  });
});

describe('InputBox slash command picker', () => {
  it('reloads project skills when session context hydrates after the composer mounts', async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      requests.push(url);
      const projectScoped = url.includes('projectId=project-1') && url.includes('cwd=%2Fworkspace%2Fproject-1');
      return Promise.resolve({
        ok: true,
        json: async () => projectScoped
          ? [{ name: '/meeting-prep', description: '회의 준비', source: 'skills', scope: 'project', kind: 'skill' }]
          : [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    useChatStore.setState({ isStreaming: false, sessionId: 's1', slashCommands: [] });
    useSessionStore.setState({
      activeSessionId: 's1',
      streamingSessions: new Set(),
      sessions: [],
    });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    await waitFor(() => expect(requests).toContain('/api/commands'));

    act(() => {
      useSessionStore.setState({
        sessions: [{
          id: 's1', name: 'Hydrated session', projectId: 'project-1', cwd: '/workspace/project-1', tags: [], favorite: false,
          totalCost: 0, totalTokens: 0, createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-20T00:00:00Z',
        }],
      });
    });

    await waitFor(() => expect(requests).toContain('/api/commands?projectId=project-1&cwd=%2Fworkspace%2Fproject-1'));
    await waitFor(() => expect(useChatStore.getState().slashCommands).toEqual([
      expect.objectContaining({ name: 'meeting-prep', scope: 'project', kind: 'skill' }),
    ]));
  });

  it('ignores an older unscoped command response after project context hydrates', async () => {
    let resolveUnscoped: ((value: { ok: boolean; json: () => Promise<unknown[]> }) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/commands') {
        return new Promise((resolve) => { resolveUnscoped = resolve; });
      }
      return Promise.resolve({
        ok: true,
        json: async () => [{ name: '/meeting-prep', description: '회의 준비', source: 'skills', scope: 'project', kind: 'skill' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    useChatStore.setState({ isStreaming: false, sessionId: 's1', slashCommands: [] });
    useSessionStore.setState({ activeSessionId: 's1', streamingSessions: new Set(), sessions: [] });

    render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/commands', expect.anything()));
    act(() => {
      useSessionStore.setState({
        sessions: [{
          id: 's1', name: 'Hydrated session', projectId: 'project-1', cwd: '/workspace/project-1', tags: [], favorite: false,
          totalCost: 0, totalTokens: 0, createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-20T00:00:00Z',
        }],
      });
    });
    await waitFor(() => expect(useChatStore.getState().slashCommands[0]?.name).toBe('meeting-prep'));

    resolveUnscoped?.({ ok: true, json: async () => [] });
    await Promise.resolve();
    expect(useChatStore.getState().slashCommands[0]?.name).toBe('meeting-prep');
  });

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
    render(<InputBox onSend={onSend} onAbort={onAbort} activeTurnStatus={<span>Active tool status</span>} />);
    expect(screen.queryByText('Active tool status')).not.toBeInTheDocument();

    expect(screen.getByText('추가 지시')).toBeInTheDocument();
    const steering = screen.getByText('추가 지시').closest('button')!;
    expect(steering).toHaveAttribute('aria-expanded', 'false');
    expect(steering.closest('.tower-steering-sheet')).toHaveClass('relative');
    expect(steering.closest('.tower-steering-sheet')).not.toHaveClass('absolute');
    expect(steering.closest('.tower-steering-sheet')).toHaveClass('pointer-events-auto', 'w-fit', 'max-w-full');
    expect(steering.closest('.tower-steering-sheet')?.parentElement).toBe(screen.getByTestId('floating-composer-companions'));
    expect(screen.getByTestId('floating-composer-companions')).toHaveClass('absolute', 'bottom-full', 'flex-col', 'pointer-events-none');
    fireEvent.click(steering);
    expect(steering).toHaveAttribute('aria-expanded', 'true');
    expect(steering).toHaveClass('overflow-y-auto');
    expect(screen.getByText('Your message · waiting for AI pickup')).toBeInTheDocument();
    expect(screen.queryByText('AI 반영 대기')).not.toBeInTheDocument();
    const send = vi.fn();
    (window as any).__towerWs = { readyState: WebSocket.OPEN, send };

    fireEvent.click(screen.getByLabelText('Cancel pending message'));

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

  it('uploads pasted capture images as file references', async () => {
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
            name: 'capture.png',
            uri: 'session://attachments/11111111-1111-4111-8111-111111111111',
            sizeBytes: 17,
            mimeType: 'image/png',
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
    const file = new File(['a,b\n1,2\n3,4'], 'capture.png', { type: 'image/png' });
    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }], getData: () => '' } });

    await waitFor(() => expect(FakeXMLHttpRequest.last?.open).toHaveBeenCalledWith('POST', '/api/session-attachments/s1'));
    await waitFor(() => {
      expect(useChatStore.getState().attachments).toEqual([
        expect.objectContaining({
          type: 'file',
          label: 'capture.png',
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

    const textarea = screen.getByPlaceholderText(/Type an answer|Answer/i);
    fireEvent.change(textarea, { target: { value: '네' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
    expect(onAnswerQuestion).toHaveBeenCalledWith('q-1', '네');
  });
});


function WelcomeComposerHarness() {
  const welcome = useSessionWelcome({ sessionId: 'session-1', projectId: 'project-1', locale: 'en', enabled: true });
  return <><span>{welcome.content?.question || 'Static welcome'}</span><InputBox onSend={vi.fn()} onAbort={vi.fn()} onInteraction={welcome.onInteraction} /></>;
}

describe('InputBox freezes pending welcome', () => {
  beforeEach(() => {
    useChatStore.setState({ sessionId: 'session-1' });
    useSessionStore.setState({ activeSessionId: 'session-1' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [], text: async () => '' })));
  });
  it.each(['focus', 'typing', 'click'])('ignores a late welcome after actual composer %s', async (interaction) => {
    let resolveWelcome!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((url) => {
      if (url === '/api/session-welcome') return new Promise<Response>((done) => { resolveWelcome = done; });
      return Promise.resolve({ ok: true, json: async () => [], text: async () => '' } as Response);
    });
    render(<WelcomeComposerHarness />);
    const textarea = screen.getByRole('textbox');
    if (interaction === 'focus') fireEvent.focus(textarea);
    if (interaction === 'typing') fireEvent.change(textarea, { target: { value: 'my work' } });
    if (interaction === 'click') fireEvent.click(textarea);
    const request = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/session-welcome');
    expect(request?.[1]?.signal?.aborted).toBe(true);
    await act(async () => resolveWelcome({ ok: true, json: async () => ({ contextLine: '', question: 'Late welcome', choices: [{ label: 'a', message: 'a' }, { label: 'b', message: 'b' }] }) } as Response));
    expect(screen.getByText('Static welcome')).toBeInTheDocument();
    expect(screen.queryByText('Late welcome')).not.toBeInTheDocument();
  });

  it('does not start a welcome request when a saved draft is restored', () => {
    localStorage.setItem('tower:inputDraft:session-1', 'unfinished user work');
    render(<WelcomeComposerHarness />);
    expect(screen.getByRole('textbox')).toHaveValue('unfinished user work');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/session-welcome')).toBe(false);
    localStorage.removeItem('tower:inputDraft:session-1');
  });
});

it('keeps composer focus on send pointer down and submits once on click', async () => {
  const onSend = vi.fn();
  render(<InputBox onSend={onSend} />);
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: 'Mobile first tap' } });
  textarea.focus();
  const send = screen.getByTitle(/send/i);
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  fireEvent(send, down);
  expect(down.defaultPrevented).toBe(true);
  expect(textarea).toHaveFocus();
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(send);
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend).toHaveBeenCalledWith('Mobile first tap');
});
