// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerConnectors } from './ComposerConnectors';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown) => ({ ok: true, json: async () => body });
describe('ComposerConnectors', () => {
  it('loads session selection and persists exclusion without claiming provider verification', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ connections: [{ id: 'notes', name: 'Notes', status: 'configured', enabled: true }] }))
      .mockResolvedValueOnce(json({ supported: true, excludedServerNames: [] }))
      .mockResolvedValueOnce(json({ supported: true, excludedServerNames: ['notes'] }));
    vi.stubGlobal('fetch', fetcher);
    render(<ComposerConnectors projectId="p" sessionId="s" />);
    const toggle = await screen.findByRole('switch');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('등록됨 · 실행 시 연결 확인')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ excludedServerNames: ['notes'], projectId: 'p' });
  });
  it('reports failed save and preserves confirmed selection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ connections: [{ id: 'notes', name: 'Notes', status: 'configured' }] }))
      .mockResolvedValueOnce(json({ supported: true, excludedServerNames: [] })).mockResolvedValueOnce({ ok: false, status: 403 }));
    render(<ComposerConnectors projectId="p" sessionId="s" />);
    const toggle = await screen.findByRole('switch');
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });
});
