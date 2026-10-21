// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { AutomationResultsPanel } from './AutomationResultsPanel';
const fetchMock = vi.fn(); const retry = vi.fn();
const item = { automationId: 'a1', automationName: 'Report', projectId: 'p1', run: { id: 'r1', status: 'failed', ranAt: '2026-09-28', summaryText: 'Failed' } as any, receipt: { readAt: null, actionedAt: null } };
const props = { items: [item], projectById: new Map([['p1', { name: 'Project' }]]), loading: false, error: null, onRetry: retry, onSelect: vi.fn(), onOpenSession: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockResolvedValue({ ok: true }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('personal result acknowledgement UI', () => {
  it('shows normal no-work independently of the successful Execution state', () => {
    render(<AutomationResultsPanel {...props} items={[{ ...item, executionStatus: 'succeeded', run: { ...item.run, status: 'none' } }]} />);
    expect(screen.getByText('resultNone')).toBeTruthy();
    expect(screen.queryByText('resultFailed')).toBeNull();
  });

  it('marks only personal acknowledgement, then refreshes authoritative results', async () => {
    render(<AutomationResultsPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'resultMarkActioned' }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/automations/results/r1/receipt');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ projectId: 'p1', action: 'actioned' });
    expect(screen.getByText('resultFailed')).toBeTruthy();
  });
  it('shows persistence failure and never silently marks a failed save as read', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    render(<AutomationResultsPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'resultMarkRead' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(retry).not.toHaveBeenCalled();
    expect(screen.getByText('resultUnread')).toBeTruthy();
  });
  it('filters unread acknowledgements independently of execution failure', () => {
    render(<AutomationResultsPanel {...props} items={[item, { ...item, run: { ...item.run, id: 'r2' }, receipt: { readAt: 'date', actionedAt: null } }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'resultUnreadOnly' }));
    expect(screen.getByTestId('automation-result-r1')).toBeTruthy();
    expect(screen.queryByTestId('automation-result-r2')).toBeNull();
  });
  it('hides receipt controls on a pre-migration result and preserves failure after action', () => {
    const { rerender } = render(<AutomationResultsPanel {...props} items={[{ ...item, receipt: undefined }]} />);
    expect(screen.queryByRole('button', { name: 'resultMarkRead' })).toBeNull();
    rerender(<AutomationResultsPanel {...props} items={[{ ...item, receipt: { readAt: 'date', actionedAt: 'date' } }]} />);
    expect(screen.getByText('resultActioned')).toBeTruthy();
    expect(screen.getByText('resultFailed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'resultMarkActioned' })).toBeNull();
  });
});
