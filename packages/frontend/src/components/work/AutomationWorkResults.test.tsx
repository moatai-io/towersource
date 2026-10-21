// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ open: vi.fn(), view: vi.fn(), session: vi.fn(), projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }] }));
const translate = (key: string) => key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('../../stores/project-store', () => ({ useProjectStore: (selector: any) => selector({ projects: m.projects }) }));
vi.mock('../../stores/file-store', () => ({ useFileStore: (selector: any) => selector({ openSystemTab: m.open }) }));
vi.mock('../../stores/session-store', () => ({ useSessionStore: { getState: () => ({ setActiveView: m.view, setActiveSessionId: m.session }) } }));
import { AutomationWorkResults } from './AutomationWorkResults';
const fetchMock = vi.fn();
const item = (id: string) => ({ automationId: `job-${id}`, automationName: `Result ${id}`, projectId: id, run: { id, status: 'failed', ranAt: '2026-09-28' }, sessionId: `session-${id}` });
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('Work automation result projection', () => {
  it('never loads a global feed, loads only the selected project and opens source detail', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [item('p1')] }) });
    render(<AutomationWorkResults />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p1' } });
    fireEvent.click(await screen.findByRole('button', { name: 'resultViewDetails' }));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/automations/results?projectId=p1&limit=20');
    expect(m.open).toHaveBeenCalledWith('schedule', expect.objectContaining({ refId: 'job-p1' }));
    fireEvent.click(screen.getByRole('button', { name: 'resultOpenSession' }));
    expect(m.view).toHaveBeenCalledWith('chat'); expect(m.session).toHaveBeenCalledWith('session-p1');
  });
  it('drops a late response from the old workspace', async () => {
    let resolveOld!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [item('p2')] }) });
    render(<AutomationWorkResults />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p2' } });
    expect(await screen.findByTestId('automation-result-p2')).toBeTruthy();
    resolveOld({ ok: true, json: async () => ({ items: [item('p1')] }) });
    await waitFor(() => expect(screen.queryByTestId('automation-result-p1')).toBeNull());
  });
  it('shows a denied fetch as an error, not empty successful results', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    render(<AutomationWorkResults />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p1' } });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
