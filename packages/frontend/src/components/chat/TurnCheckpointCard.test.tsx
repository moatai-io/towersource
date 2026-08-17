// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TurnCheckpointCard } from './TurnCheckpointCard';

beforeEach(() => {
  localStorage.setItem('token', 'test-token');
  vi.restoreAllMocks();
});

describe('TurnCheckpointCard', () => {
  it('progressively discloses preview and requires confirmation before apply', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'cp-1', coverage: 'tool_edits', changes: [{ filePath: '/workspace/a.md', beforeExists: true, afterExists: true }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ previewHash: 'hash-1', canApply: true, coverage: 'tool_edits', items: [{ filePath: '/workspace/a.md', action: 'update', status: 'ready' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ restoredPaths: ['/workspace/a.md'] }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<TurnCheckpointCard sessionId="s1" turnId="t1" />);

    fireEvent.click(screen.getByRole('button', { name: '이 턴의 파일 변경 확인' }));
    expect(await screen.findByText('a.md')).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: '선택한 파일 1개 복원' });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByText('선택한 파일의 현재 내용을 턴 시작 전 내용으로 교체하는 것을 확인했습니다.'));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(await screen.findByText('선택한 파일을 턴 시작 전 상태로 복원했습니다.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/checkpoints/cp-1/restore', expect.objectContaining({ body: JSON.stringify({ confirmed: true, previewHash: 'hash-1', paths: ['/workspace/a.md'] }) }));
  });

  it('shows partial coverage and blocks conflict restore', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'cp-2', coverage: 'partial', changes: [{ filePath: '/workspace/b.md', beforeExists: true, afterExists: true }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ previewHash: 'hash-2', canApply: false, coverage: 'partial', items: [{ filePath: '/workspace/b.md', action: 'update', status: 'conflict' }] }) }));
    render(<TurnCheckpointCard sessionId="s1" turnId="t2" />);
    fireEvent.click(screen.getByRole('button', { name: '이 턴의 파일 변경 확인' }));
    expect(await screen.findByText('일부 변경만 기록됨')).toBeInTheDocument();
    expect(screen.getByText('이후 변경 있음')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /복원$/ })).toBeNull();
    expect(screen.getByText(/이 턴 이후 변경된 파일이 있어/)).toBeInTheDocument();
  });

  it('re-previews after selection changes instead of applying a stale hash', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'cp-3', coverage: 'tool_edits', changes: [{ filePath: '/workspace/a.md' }, { filePath: '/workspace/b.md' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ previewHash: 'all', canApply: true, coverage: 'tool_edits', items: [{ filePath: '/workspace/a.md', action: 'update', status: 'ready' }, { filePath: '/workspace/b.md', action: 'update', status: 'ready' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ previewHash: 'one', canApply: true, coverage: 'tool_edits', items: [{ filePath: '/workspace/a.md', action: 'update', status: 'ready' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<TurnCheckpointCard sessionId="s1" turnId="t3" />);
    fireEvent.click(screen.getByRole('button', { name: '이 턴의 파일 변경 확인' }));
    await screen.findByText('b.md');
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(screen.queryByText('선택한 파일의 현재 내용을 턴 시작 전 내용으로 교체하는 것을 확인했습니다.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '선택 상태 확인' }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/checkpoints/cp-3/restore-preview', expect.objectContaining({ body: JSON.stringify({ paths: ['/workspace/a.md'] }) })));
  });
});
