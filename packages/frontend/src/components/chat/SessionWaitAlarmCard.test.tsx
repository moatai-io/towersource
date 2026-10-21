// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionWaitAlarmCard, remainingWaitMinutes } from './SessionWaitAlarmCard';
import { useSessionWaitAlarm, WAIT_ALARM_POLL_MS, type SessionWaitAlarm } from './useSessionWaitAlarm';
import ko from '../../locales/ko/chat.json';
import en from '../../locales/en/chat.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  i18n: { language: 'ko' },
  t: (key: string, options: Record<string, unknown> = {}) => {
    const value = key.split('.').reduce<unknown>((current, segment) => (current as Record<string, unknown>)?.[segment], ko);
    return String(value ?? options.defaultValue ?? key).replace(/{{(\w+)}}/g, (_, name) => String(options[name] ?? ''));
  },
}) }));
vi.mock('../../utils/server-clock', () => ({ serverNowMs: () => Date.parse('2026-10-12T00:00:00Z') }));

const alarm: SessionWaitAlarm = {
  id: 'alarm-1', sessionId: 'session-a', status: 'pending', reason: '자료가 도착하면 확인',
  wakeAt: '2026-10-12T02:10:00Z', version: 1, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
};
const reply = (value: SessionWaitAlarm | null = alarm, canManage = true) => ({ ok: true, json: async () => ({ alarm: value, canManage }) });
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue(reply());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Harness({ sessionId = 'session-a' }: { sessionId?: string }) {
  const state = useSessionWaitAlarm(sessionId, false);
  return <div><span>{state.alarm?.reason ?? 'none'}</span><button onClick={() => { void state.refresh(); }}>refresh</button></div>;
}

describe('saved session wait alarm', () => {
  it('defaults to a compact disclosure and opens details only on demand', async () => {
    render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    await screen.findByText(alarm.reason);
    const disclosure = document.querySelector('details')!;
    expect(disclosure.open).toBe(false);
    expect(screen.getByTestId('floating-wait-alarm')).toHaveClass('absolute', 'top-0', 'pointer-events-none', 'bg-transparent');
    expect(disclosure).toHaveClass('pointer-events-auto');
    expect(disclosure.querySelector('summary')).toHaveTextContent('2시간 10분 남음');
    expect(disclosure.querySelector('aside')).toHaveClass('absolute', 'overflow-y-auto');
    fireEvent.click(disclosure.querySelector('summary')!);
    expect(disclosure.open).toBe(true);
  });

  it('recovers pending alarm with hours, reason, semantic clock and controls on mount', async () => {
    render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    expect(await screen.findByText(alarm.reason)).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('2시간 10분 남음');
    expect(document.querySelector('time')).toHaveAttribute('datetime', alarm.wakeAt);
    expect(screen.getByRole('button', { name: '지금 이어가기' })).toBeEnabled();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/session-a/wait-alarm');
  });

  it('does not present running activity for due or terminal alarms', async () => {
    fetchMock.mockResolvedValue(reply({ ...alarm, wakeAt: '2026-10-11T00:00:00Z' }));
    const view = render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    expect(await screen.findByText('재개를 기다리는 중')).toBeInTheDocument();
    expect(screen.getByText(/아직 자동 재개되지/)).toBeInTheDocument();
    expect(view.container.innerHTML).not.toContain('animate-spin');
    view.unmount();
    fetchMock.mockResolvedValue(reply({ ...alarm, status: 'admitted' }));
    const terminal = render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(terminal.container).toBeEmptyDOMElement();
  });

  it('shows shared-session alarms read-only', async () => {
    fetchMock.mockResolvedValue(reply(alarm, false));
    render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    expect(await screen.findByText(alarm.reason)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '알람 취소' })).not.toBeInTheDocument();
  });

  it.each(['지금 이어가기', '알람 취소'])('posts versioned %s once and projects the backend result', async (label) => {
    render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    const control = await screen.findByRole('button', { name: label });
    // /now makes a pending alarm due; only scheduler admission makes it terminal.
    fetchMock.mockResolvedValue(reply({ ...alarm, status: label === '알람 취소' ? 'cancelled' : 'pending', wakeAt: '2026-10-12T00:00:00Z', version: 2 }));
    fireEvent.click(control);
    if (label === '알람 취소') {
      await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
    } else {
      expect(await screen.findByText('재개를 기다리는 중')).toBeInTheDocument();
      expect(screen.getByText(/아직 자동 재개되지/)).toBeInTheDocument();
    }
    const calls = fetchMock.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain(label === '알람 취소' ? '/cancel' : '/now');
    expect(JSON.parse(calls[0][1].body)).toEqual({ id: alarm.id, version: 1 });
  });

  it('changes local time to an ISO instant and validates the 30-day bound', async () => {
    render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '시간 변경' }));
    const input = screen.getByLabelText('재개 시각 (현재 시간대)');
    fireEvent.change(input, { target: { value: '2027-01-01T10:00' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText(/30일 이내/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    const local = '2026-10-13T10:00';
    fireEvent.change(input, { target: { value: local } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init.method === 'POST')).toBe(true));
    const [url, init] = fetchMock.mock.calls.find(([, init]) => init.method === 'POST')!;
    expect(url).toContain('/reschedule');
    expect(JSON.parse(init.body)).toEqual({ id: alarm.id, version: 1, wakeAt: new Date(local).toISOString() });
  });

  it('refreshes conflicts without retrying the write', async () => {
    render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    const control = await screen.findByRole('button', { name: '지금 이어가기' });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409 }).mockResolvedValue(reply({ ...alarm, version: 2 }));
    fireEvent.click(control);
    expect(await screen.findByText(/알람이 변경되었습니다/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('polls at a bounded interval, pauses hidden tabs, refreshes on return and cleans up', async () => {
    vi.useFakeTimers();
    const view = render(<Harness />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(WAIT_ALARM_POLL_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { vi.advanceTimersByTime(WAIT_ALARM_POLL_MS * 3); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { fireEvent(document, new Event('visibilitychange')); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(WAIT_ALARM_POLL_MS * 3); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps in-flight controls safe across streaming changes and hidden tabs without duplicate writes', async () => {
    vi.useFakeTimers();
    const view = render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    await act(async () => {});
    let resolve!: (value: ReturnType<typeof reply>) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: '지금 이어가기' }));
    const signal = fetchMock.mock.calls[1][1].signal;
    view.rerender(<SessionWaitAlarmCard sessionId="session-a" isStreaming />);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(signal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '지금 이어가기' })).toBeDisabled();
    await act(async () => { resolve(reply({ ...alarm, wakeAt: '2026-10-12T00:00:00Z', version: 2 })); });
    expect(screen.getByRole('button', { name: '지금 이어가기' })).toBeEnabled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { fireEvent(document, new Event('visibilitychange')); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('times out an ambiguous control and reconciles via GET without retrying POST', async () => {
    vi.useFakeTimers();
    render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    await act(async () => {});
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    fireEvent.click(screen.getByRole('button', { name: '지금 이어가기' }));
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '지금 이어가기' })).toBeEnabled();
    expect(screen.getByText(/요청 결과를 확인하지 못했습니다/)).toBeInTheDocument();
  });

  it('removes owner controls when the server rejects a permission change', async () => {
    render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    const control = await screen.findByRole('button', { name: '알람 취소' });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 }).mockResolvedValue(reply(alarm, false));
    fireEvent.click(control);
    expect(await screen.findByText(/세션 소유자만/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '알람 취소' })).not.toBeInTheDocument();
  });

  it('aborts old-session loads and never displays their late results', async () => {
    let resolve!: (value: ReturnType<typeof reply>) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<Harness />);
    const signal = fetchMock.mock.calls[0][1].signal;
    fetchMock.mockResolvedValue(reply({ ...alarm, sessionId: 'session-b', reason: '새 세션 알람' }));
    view.rerender(<Harness sessionId="session-b" />);
    expect(signal.aborted).toBe(true);
    expect(await screen.findByText('새 세션 알람')).toBeInTheDocument();
    await act(async () => { resolve(reply()); });
    expect(screen.queryByText(alarm.reason)).not.toBeInTheDocument();
  });

  it('cancels an old-session control without leaving the next session disabled', async () => {
    const view = render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    const control = await screen.findByRole('button', { name: '알람 취소' });
    let resolve!: (value: ReturnType<typeof reply>) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(control);
    const signal = fetchMock.mock.calls[1][1].signal;
    fetchMock.mockResolvedValue(reply({ ...alarm, id: 'alarm-b', sessionId: 'session-b', reason: '새 세션 알람' }));
    view.rerender(<SessionWaitAlarmCard sessionId="session-b" isStreaming={false} />);
    expect(signal.aborted).toBe(true);
    expect(await screen.findByText('새 세션 알람')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '알람 취소' })).toBeEnabled();
    await act(async () => { resolve(reply({ ...alarm, status: 'cancelled' })); });
    expect(screen.getByText('새 세션 알람')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '알람 취소' })).toBeEnabled();
  });

  it('does not display an outdated countdown after a load failure', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    render(<SessionWaitAlarmCard sessionId="session-a" isStreaming={false} />);
    expect(await screen.findByText(/알람 상태를 확인하지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 확인' })).toBeEnabled();
  });

  it('mounts the alarm beside the conversation with a session-keyed lifecycle', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'ChatPanel.tsx'), 'utf8');
    expect(source).toContain('<SessionWaitAlarmCard key={activeSessionId} sessionId={activeSessionId} isStreaming={isStreaming} />');
    expect(source.indexOf('<SessionWaitAlarmCard')).toBeLessThan(source.indexOf('<ConversationBranchProvenance'));
  });

  it('keeps Korean and English alarm resources complete and rounds remaining minutes safely', () => {
    expect(Object.keys(ko.waitAlarm).sort()).toEqual(Object.keys(en.waitAlarm).sort());
    expect(Object.keys(ko.waitAlarm.errors).sort()).toEqual(Object.keys(en.waitAlarm.errors).sort());
    expect(remainingWaitMinutes('2026-10-12T00:00:01Z', Date.parse('2026-10-12T00:00:00Z'))).toBe(1);
    expect(remainingWaitMinutes('2026-10-12T00:00:00Z', Date.parse('2026-10-12T00:00:01Z'))).toBe(0);
  });
});
