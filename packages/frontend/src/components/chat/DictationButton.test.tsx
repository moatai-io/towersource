// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DictationButton } from './DictationButton';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('requires a session and never submits a chat message', () => {
  render(<DictationButton sessionId={null} onText={vi.fn()} />);
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});
it('reports unavailable microphone support without adding text', async () => {
  const onText = vi.fn();
  render(<DictationButton sessionId="session" onText={onText} />);
  fireEvent.click(screen.getByRole('button', { name: '음성 입력 시작' }));
  expect((await screen.findByRole('alert')).textContent).toContain('지원하지 않습니다');
  expect(onText).not.toHaveBeenCalled();
});

it('converts HTML fallback into an actionable error instead of a JSON syntax error', async () => {
  const { readDictationResponse } = await import('./DictationButton');
  await expect(readDictationResponse(new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html' } }))).rejects.toThrow('음성 입력 서버가 올바르게 연결되지 않았습니다');
});
it('validates successful transcription and JSON failures', async () => {
  const { readDictationResponse } = await import('./DictationButton');
  await expect(readDictationResponse(Response.json({ text: '안녕하세요' }))).resolves.toBe('안녕하세요');
  await expect(readDictationResponse(Response.json({ error: '연결 준비 중' }, { status: 503 }))).rejects.toThrow('연결 준비 중');
});
it('clears the error when switching sessions', async () => {
  const { rerender } = render(<DictationButton sessionId="first" onText={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '음성 입력 시작' }));
  await screen.findByRole('alert');
  rerender(<DictationButton sessionId="second" onText={vi.fn()} />);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: '음성 입력 시작' })).toBeTruthy();
});
it('shows live controls, forwards preview, and waits for final text', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const module = await import('./realtime-dictation');
  const connection = { stream: { getTracks: () => [] }, cancel: vi.fn(), finish: vi.fn().mockResolvedValue('확정 문장') };
  const start = vi.spyOn(module, 'startRealtimeDictation').mockResolvedValue(connection as any);
  vi.stubGlobal('AudioContext', class { createAnalyser() { return { fftSize: 256, getByteTimeDomainData: (a: Uint8Array) => a.fill(128) }; } createMediaStreamSource() { return { connect() {} }; } close() { return Promise.resolve(); } });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
  const onText = vi.fn(); const onPreview = vi.fn();
  const waveformTarget = document.createElement('div'); document.body.append(waveformTarget);
  render(<DictationButton sessionId="live" onText={onText} onPreview={onPreview} waveformTarget={waveformTarget} />);
  fireEvent.click(screen.getByRole('button', { name: '음성 입력 시작' }));
  const confirm = await screen.findByRole('button', { name: '녹음 종료 및 받아쓰기' });
  expect(screen.queryByRole('button', { name: '음성 입력 취소' })).toBeNull();
  expect(screen.getByLabelText('녹음 음량 파형')).toBeTruthy();
  start.mock.calls[0][1]('미리보기'); expect(onPreview).toHaveBeenCalledWith('미리보기');
  fireEvent.keyDown(window, { key: 'v', code: 'KeyV', altKey: true });
  await vi.waitFor(() => expect(onText).toHaveBeenCalledWith('확정 문장'));
  waveformTarget.remove(); start.mockRestore(); vi.unstubAllGlobals();
});

it.each(['v', '√'])('starts dictation with Option+V (%s)', async (key) => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  render(<DictationButton sessionId="session" onText={vi.fn()} />);
  fireEvent.keyDown(window, { key, code: 'KeyV', altKey: true });
  expect((await screen.findByRole('alert')).textContent).toContain('지원하지 않습니다');
});

it('ignores repeat, composition, missing session and unrelated text fields', () => {
  const { rerender } = render(<DictationButton sessionId={null} onText={vi.fn()} />);
  fireEvent.keyDown(window, { key: 'v', code: 'KeyV', altKey: true });
  rerender(<DictationButton sessionId="session" onText={vi.fn()} />);
  fireEvent.keyDown(window, { key: 'v', code: 'KeyV', altKey: true, repeat: true });
  fireEvent.keyDown(window, { key: 'v', code: 'KeyV', altKey: true, isComposing: true });
  const input = document.createElement('input');
  document.body.append(input);
  fireEvent.keyDown(input, { key: 'v', code: 'KeyV', altKey: true });
  input.remove();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('allows the active composer but not modal text entry to start dictation', async () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  render(<div data-chat-composer><textarea aria-label="draft" /><DictationButton sessionId="session" onText={vi.fn()} /></div>);
  const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
  fireEvent.keyDown(screen.getByLabelText('draft'), { key: 'v', code: 'KeyV', altKey: true });
  expect(screen.queryByRole('alert')).toBeNull(); modal.remove();
  fireEvent.keyDown(screen.getByLabelText('draft'), { key: 'v', code: 'KeyV', altKey: true });
  expect((await screen.findByRole('alert')).textContent).toContain('지원하지 않습니다');
});
