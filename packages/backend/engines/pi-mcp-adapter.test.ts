import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mcpServerToPiTools } from './pi-mcp-adapter.js';

function setup(handler: ReturnType<typeof vi.fn>) {
  return mcpServerToPiTools({ demo: { instance: { _registeredTools: {
    run: { inputSchema: { value: z.string() }, handler },
  } } } })[0];
}

describe('Pi MCP execution failure contract', () => {
  it('preserves successful content, call id and abort signal', async () => {
    const content = [{ type: 'text', text: 'ok' }];
    const handler = vi.fn().mockResolvedValue({ content });
    const signal = new AbortController().signal;
    await expect(setup(handler).execute('call-1', { value: 'test' }, signal))
      .resolves.toEqual({ content, details: undefined });
    expect(handler).toHaveBeenCalledWith({ value: 'test' }, { signal, toolCallId: 'call-1' });
  });
  it('rejects MCP errors while retaining every text block', async () => {
    const handler = vi.fn().mockResolvedValue({ isError: true, content: [
      { type: 'text', text: 'failed' }, { type: 'text', text: 'retry same request' },
    ] });
    await expect(setup(handler).execute('call-2', {}, undefined))
      .rejects.toThrow('failed\nretry same request');
  });
  it('rejects empty MCP errors with a useful fallback', async () => {
    await expect(setup(vi.fn().mockResolvedValue({ isError: true })).execute('call-3', {}, undefined))
      .rejects.toThrow('[MCP tool returned error with no content]');
  });
  it('does not turn handler exceptions into successful results', async () => {
    await expect(setup(vi.fn().mockRejectedValue(new Error('synthetic failure'))).execute('call-4', {}, undefined))
      .rejects.toThrow('[MCP tool error] mcp__demo__run: synthetic failure');
  });
});
