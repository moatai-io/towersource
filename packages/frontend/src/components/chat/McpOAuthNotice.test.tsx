// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../utils/toast', () => ({ toastSuccess: toast.success, toastError: toast.error }));
import { McpOAuthNotice } from './McpOAuthNotice';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('McpOAuthNotice', () => {
  it('consumes the fixed result marker without discarding other navigation state', () => {
    history.replaceState({}, '', '/?mcpAuth=connected&tab=chat#active');
    render(<McpOAuthNotice />);
    expect(toast.success).toHaveBeenCalledOnce();
    expect(location.search).toBe('?tab=chat');
    expect(location.hash).toBe('#active');
  });
  it('does not display untrusted provider error text', () => {
    history.replaceState({}, '', '/?mcpAuth=arbitrary-provider-text');
    render(<McpOAuthNotice />);
    expect(toast.error).not.toHaveBeenCalled();
    expect(location.search).toBe('');
  });
});
