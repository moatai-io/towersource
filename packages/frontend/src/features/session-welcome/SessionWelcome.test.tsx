// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@tower/shared';
import ko from '../../locales/ko/chat.json';
import en from '../../locales/en/chat.json';
import { useSessionStore } from '../../stores/session-store';
import { SessionWelcome } from './SessionWelcome';
import { parseWelcomeContent, useSessionWelcome, type WelcomeContent } from './useSessionWelcome';

const personalized: WelcomeContent = {
  contextLine: '작성 중인 보고서가 있군요.', question: '보고서에서 어디를 같이 볼까요?',
  choices: [{ label: '구성을 살펴봐 주세요.', message: '보고서의 구성을 검토해 주세요.' }, { label: '표현을 다듬어 주세요.', message: '보고서 문장을 다듬어 주세요.' }],
};
const project = { id: 'p1', name: 'arbitrary-project-name', agent: { displayName: '검토 동료', face: '🦉' } } as Project;
let i18n: ReturnType<typeof createInstance>;
beforeEach(async () => {
  localStorage.clear();
  useSessionStore.setState({ sessions: [] });
  i18n = createInstance();
  await i18n.init({ lng: 'ko', fallbackLng: false, resources: { ko: { chat: ko }, en: { chat: en } }, ns: ['chat'], defaultNS: 'chat', interpolation: { escapeValue: false } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function Harness({ sessionId = 's1', projectId = 'p1', enabled = true }: { sessionId?: string; projectId?: string; enabled?: boolean }) {
  const welcome = useSessionWelcome({ sessionId, projectId, locale: 'ko', enabled });
  return <I18nextProvider i18n={i18n}><SessionWelcome project={project} content={welcome.content} isLoading={welcome.isLoading} onStart={vi.fn()} onInteraction={welcome.onInteraction} /></I18nextProvider>;
}
function deferredFetch() {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, get resolve() { const done = resolve; return () => done({ ok: true, json: async () => personalized } as Response); } };
}

describe('conversational session welcome', () => {
  it('renders identity, a polite question, three dialogue choices and free input immediately', () => {
    deferredFetch();
    render(<Harness />);
    expect(screen.getByText('검토 동료')).toBeTruthy();
    expect(screen.getByText(ko.welcome.question)).toBeTruthy();
    expect(screen.getByText(ko.welcome.freeInput)).toBeTruthy();
    expect(screen.getByRole('button', { name: ko.welcome.choices[0].label })).toBeTruthy();
    expect(screen.queryByText(personalized.question)).toBeNull();
  });
  it('uses the profile name, not a legacy project name, and supports English defaults', async () => {
    await i18n.changeLanguage('en');
    render(<I18nextProvider i18n={i18n}><SessionWelcome project={{ ...project, agent: undefined }} content={null} onStart={vi.fn()} onInteraction={vi.fn()} /></I18nextProvider>);
    expect(screen.getByText(en.welcome.defaultName)).toBeTruthy();
    expect(screen.queryByText(project.name)).toBeNull();
    expect(screen.getByText(en.welcome.question)).toBeTruthy();
  });
  it('applies a valid API result before interaction and sends only the real user message', async () => {
    const request = deferredFetch();
    const onStart = vi.fn();
    const onInteraction = vi.fn();
    const hook = renderHook(() => useSessionWelcome({ sessionId: 's1', projectId: 'p1', locale: 'ko', enabled: true }));
    await act(async () => request.resolve());
    expect(request.fetchMock).toHaveBeenCalledWith('/api/session-welcome', expect.objectContaining({ credentials: 'include', body: JSON.stringify({ projectId: 'p1', sessionId: 's1', locale: 'ko' }) }));
    render(<I18nextProvider i18n={i18n}><SessionWelcome project={project} content={hook.result.current.content} onStart={onStart} onInteraction={onInteraction} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: personalized.choices[0].label }));
    expect(onInteraction).toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledWith(personalized.choices[0].message);
    expect(onStart.mock.calls[0]).toHaveLength(1);
  });
  it('keeps static choices after a click even if a provider ignores abort', async () => {
    const request = deferredFetch();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: ko.welcome.choices[0].label }));
    expect((request.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
    await act(async () => request.resolve());
    expect(screen.getByText(ko.welcome.question)).toBeTruthy();
    expect(screen.queryByText(personalized.question)).toBeNull();
  });
  it.each(['sessionId', 'projectId'] as const)('aborts old requests and cannot show another %s result', async (field) => {
    const request = deferredFetch();
    const { rerender } = render(<Harness />);
    const resolveOld = request.resolve;
    const signal = (request.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
    rerender(<Harness {...{ [field]: 'next' }} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveOld());
    expect(screen.getByText(ko.welcome.question)).toBeTruthy();
    expect(screen.queryByText(personalized.question)).toBeNull();
  });
  it('does not request while messages are loading or a real conversation is present', () => {
    const request = deferredFetch();
    render(<Harness enabled={false} />);
    expect(request.fetchMock).not.toHaveBeenCalled();
  });
  it('bounds the client wait and ignores a late response after timeout', async () => {
    vi.useFakeTimers();
    const request = deferredFetch();
    render(<Harness />);
    expect(screen.getByRole('status')).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(6500));
    expect(screen.queryByRole('status')).toBeNull();
    expect((request.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
    await act(async () => request.resolve());
    expect(screen.queryByText(personalized.question)).toBeNull();
  });
  it.each([null, {}, { ...personalized, choices: [] }, { ...personalized, choices: [{ label: '', message: 'x' }, personalized.choices[1]] }])('rejects malformed response and retains fallback (%j)', async (invalid) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => invalid })));
    render(<Harness />);
    await waitFor(() => expect(screen.getByText(ko.welcome.question)).toBeTruthy());
    expect(parseWelcomeContent(invalid)).toBeNull();
  });
  it('keeps all localized static choices inside the API limits', () => {
    for (const locale of [ko, en]) {
      expect(parseWelcomeContent({ contextLine: '', question: locale.welcome.question, choices: locale.welcome.choices })).not.toBeNull();
    }
  });
  it('ignores a late request after unmount', async () => {
    const request = deferredFetch();
    const { unmount } = render(<Harness />);
    const signal = (request.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => request.resolve());
    expect(screen.queryByText(personalized.question)).toBeNull();
  });
  it.each(['failure', 'non-ok'])('keeps the complete static welcome on API %s', async (mode) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'failure') throw new Error('provider unavailable');
      return { ok: false, json: async () => personalized };
    }));
    render(<Harness />);
    await act(async () => {});
    expect(screen.getByText(ko.welcome.question)).toBeTruthy();
    expect(screen.queryByText(personalized.question)).toBeNull();
  });
  it('retains the first-session tour and chat guide paths', () => {
    const onStart = vi.fn();
    const listener = vi.fn();
    window.addEventListener('tower-start-tour', listener);
    render(<I18nextProvider i18n={i18n}><SessionWelcome project={project} content={null} onStart={onStart} onInteraction={vi.fn()} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: ko.emptyState.startGuide }));
    expect(listener.mock.calls[0][0].detail.tourId).toBe('beginner');
    fireEvent.click(screen.getByRole('button', { name: ko.emptyState.askInChat }));
    expect(onStart).toHaveBeenCalledWith('/tower-intro');
    window.removeEventListener('tower-start-tour', listener);
  });
});
