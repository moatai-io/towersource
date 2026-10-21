// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpConnectionManager } from './McpConnectionManager';
afterEach(cleanup);
describe('McpConnectionManager', () => {
  it('requires immediate confirmation before deleting an Agent shared connection', async () => {
    const request = vi.fn().mockResolvedValue({ removed: true });
    const changed = vi.fn();
    render(<McpConnectionManager projectId="agent" connections={[{ id: 'notes', status: 'connected' }]} request={request} onChanged={changed} />);
    fireEvent.click(screen.getByText('커넥터 추가·관리'));
    fireEvent.click(screen.getByText('삭제'));
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText(/모든 대화에서 사용할 수 없습니다/)).toBeTruthy();
    fireEvent.click(screen.getByText('확인'));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith('/api/projects/agent/mcp/connections/notes', { method: 'DELETE' });
  });
  it('registers explicit OAuth intent without starting account authentication', async () => {
    const request = vi.fn().mockResolvedValue({ connection: {} });
    render(<McpConnectionManager projectId="agent" connections={[]} request={request} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByText('커넥터 추가·관리'));
    fireEvent.click(screen.getByText('+ 원격 MCP 추가'));
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'notes' } });
    fireEvent.change(screen.getByLabelText('MCP 서버 주소'), { target: { value: 'https://service.example.com/mcp' } });
    fireEvent.submit(screen.getByText('추가').closest('form')!);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ name: 'notes', url: 'https://service.example.com/mcp', authType: 'oauth' });
  });
});
