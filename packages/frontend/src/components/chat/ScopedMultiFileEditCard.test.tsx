// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ScopedMultiFileEditCard, type ScopedMultiFileProposal } from './ScopedMultiFileEditCard';

const proposal: ScopedMultiFileProposal = {
  version: 1,
  intentId: 'intent-1',
  proposalHash: 'a'.repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  files: [
    { path: '/workspace/demo/index.html', ranges: [{ start: 1, end: 2, lineStart: 4, lineEnd: 4, kind: 'html-element' }] },
    { path: '/workspace/demo/styles.css', ranges: [{ start: 3, end: 4, lineStart: 8, lineEnd: 10, kind: 'css-rule', selector: '.cta' }] },
  ],
};

beforeEach(() => { localStorage.setItem('token', 'test-token'); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('ScopedMultiFileEditCard', () => {
  it('shows exact files and ranges and requires checkbox confirmation before apply', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'previewed', preview: proposal }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, applied: true }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ScopedMultiFileEditCard proposal={proposal} />);
    expect(screen.getByText('/workspace/demo/index.html')).toBeInTheDocument();
    expect(screen.getByText('.cta', { exact: false })).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: '승인하고 함께 적용' });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(apply);
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/files/scoped-edit/multi-file-apply', expect.objectContaining({
      body: JSON.stringify({ intentId: proposal.intentId, proposalHash: proposal.proposalHash, confirmed: true }),
    })));
    expect(await screen.findByText('승인된 범위를 모든 파일에 적용했습니다.')).toBeInTheDocument();
  });

  it('renders an already-applied intent as non-actionable after reload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'applied', preview: proposal }) }));
    render(<ScopedMultiFileEditCard proposal={proposal} />);
    expect(await screen.findByText('승인된 범위를 모든 파일에 적용했습니다.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '승인하고 함께 적용' })).not.toBeInTheDocument();
  });
});
