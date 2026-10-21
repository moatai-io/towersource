// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InputBox } from './InputBox';
import { useChatStore } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';
import { optimizeBatch } from '../../utils/file-optimizer';
import { uploadFileBatchWithProgress } from '../../utils/upload-with-progress';
import i18n from '../../i18n';

vi.mock('../../utils/file-optimizer', () => ({ optimizeBatch: vi.fn(), formatBytes: String }));
vi.mock('../../utils/upload-with-progress', () => ({ uploadFileBatchWithProgress: vi.fn() }));
const uri = 'session://attachments/11111111-1111-4111-8111-111111111111';
const result = { attachments: [{ id: 'file-a', name: 'a.csv', sizeBytes: 3, mimeType: 'text/csv', uri }] };
let complete!: (value: typeof result | { failures: { name: string; error: string }[] }) => void;

function switchTo(sessionId: string) {
  act(() => {
    useChatStore.getState().setSessionId(sessionId);
    useSessionStore.setState({ activeSessionId: sessionId });
  });
}
function selectFile(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [new File(['a,b'], 'a.csv', { type: 'text/csv' })] },
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  await i18n.changeLanguage('en');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  Element.prototype.scrollIntoView = vi.fn();
  useChatStore.setState({ sessionId: 'a', attachments: [], attachmentDrafts: {}, attachmentUploadProgress: {},
    isStreaming: false, messages: [], slashCommands: [], messageQueue: {}, pendingInjections: {}, pendingQuestion: null });
  useSessionStore.setState({ activeSessionId: 'a', sessions: [], streamingSessions: new Set(), unreadSessions: new Set() });
  vi.mocked(optimizeBatch).mockImplementation(async (files) => ({ files, originalBytes: 3, optimizedBytes: 3, changedCount: 0, notes: [] }));
  vi.mocked(uploadFileBatchWithProgress).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
});

describe('attachment composer ownership and send barrier', () => {
  it('waits on Enter then sends exactly once with the uploaded URI', async () => {
    const onSend = vi.fn();
    const { container } = render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    selectFile(container);
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: '첨부 확인' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(uploadFileBatchWithProgress).toHaveBeenCalled());
    await act(async () => complete(result));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toContain(uri);
    expect(onSend.mock.calls[0][0]).toContain('첨부 확인');
    switchTo('b');
    switchTo('a');
    expect(useChatStore.getState().attachments).toEqual([]);
  });

  it('queues an attachment-only button send while upload is still running', async () => {
    const onSend = vi.fn();
    const { container } = render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    selectFile(container);
    const button = screen.getByLabelText('Send message') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(uploadFileBatchWithProgress).toHaveBeenCalled());
    await act(async () => complete(result));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toContain(uri);
  });

  it('keeps the upload owner even when switching during file optimization', async () => {
    let finishOptimization!: (value: any) => void;
    vi.mocked(optimizeBatch).mockImplementationOnce(() => new Promise((resolve) => { finishOptimization = resolve; }));
    const { container } = render(<InputBox onSend={vi.fn()} onAbort={vi.fn()} />);
    selectFile(container);
    switchTo('b');
    await act(async () => finishOptimization({ files: [new File(['a,b'], 'a.csv')], originalBytes: 3, optimizedBytes: 3, changedCount: 0, notes: [] }));
    await waitFor(() => expect(uploadFileBatchWithProgress).toHaveBeenCalled());
    expect(vi.mocked(uploadFileBatchWithProgress).mock.calls[0][0].url).toBe('/api/session-attachments/a');
    await act(async () => complete(result));
    expect(useChatStore.getState().attachments).toEqual([]);
    switchTo('a');
    expect(useChatStore.getState().attachments[0].content).toBe(uri);
  });

  it('does not send from an unmounted composer when a background upload finishes', async () => {
    const onSend = vi.fn();
    const { container, unmount } = render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    selectFile(container);
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: '남길 초안' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(uploadFileBatchWithProgress).toHaveBeenCalled());
    unmount();
    await act(async () => complete(result));
    expect(onSend).not.toHaveBeenCalled();
    render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    expect(useChatStore.getState().attachments[0].content).toBe(uri);
    expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).value).toBe('남길 초안');
  });

  it('restores the originating draft and cancels automatic send after a session switch', async () => {
    const onSend = vi.fn();
    const { container } = render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    selectFile(container);
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: '원래 세션' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    switchTo('b');
    await waitFor(() => expect(uploadFileBatchWithProgress).toHaveBeenCalled());
    expect(vi.mocked(uploadFileBatchWithProgress).mock.calls[0][0].url).toBe('/api/session-attachments/a');
    await act(async () => complete(result));
    expect(onSend).not.toHaveBeenCalled();
    expect(useChatStore.getState().attachments).toEqual([]);
    switchTo('a');
    expect(useChatStore.getState().attachments[0].content).toBe(uri);
    expect((textarea as HTMLTextAreaElement).value).toBe('원래 세션');
  });

  it('does not lock another session while the original send is waiting', async () => {
    const onSend = vi.fn();
    const { container } = render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    selectFile(container);
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'A 초안' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    switchTo('b');
    fireEvent.change(textarea, { target: { value: 'B 메시지' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('B 메시지');
    await waitFor(() => expect(uploadFileBatchWithProgress).toHaveBeenCalled());
    await act(async () => complete(result));
    expect(onSend).toHaveBeenCalledTimes(1);
    switchTo('a');
    expect(useChatStore.getState().attachments[0].content).toBe(uri);
  });

  it('keeps text and does not auto-send when upload fails', async () => {
    const onSend = vi.fn();
    const { container } = render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    selectFile(container);
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: '실패 초안' } });
    expect((screen.getByLabelText('Send message') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(uploadFileBatchWithProgress).toHaveBeenCalled());
    await act(async () => complete({ failures: [{ name: 'a.csv', error: 'failed' }] }));
    expect(onSend).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe('실패 초안');
  });

  it('does not discard text edited while a send is waiting', async () => {
    const onSend = vi.fn();
    const { container } = render(<InputBox onSend={onSend} onAbort={vi.fn()} />);
    selectFile(container);
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: '초안' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.change(textarea, { target: { value: '수정된 초안' } });
    await waitFor(() => expect(uploadFileBatchWithProgress).toHaveBeenCalled());
    await act(async () => complete(result));
    expect(onSend).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe('수정된 초안');
    expect(useChatStore.getState().attachments[0].content).toBe(uri);
  });
});
