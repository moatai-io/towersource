// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({ confirm: vi.fn(), openChatTab: vi.fn(), setActiveSessionId: vi.fn(), setActiveView: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../hooks/useDialog', () => ({ useConfirm: () => actions.confirm }));
vi.mock('../../stores/project-store', () => ({ useProjectStore: (pick: any) => pick({ projects: [{ id: 'project-one', name: 'Project one' }, { id: 'project-two', name: 'Project two' }] }) }));
vi.mock('../../stores/file-store', () => ({ useFileStore: (pick: any) => pick({ openSystemTab: vi.fn(), openChatTab: actions.openChatTab }) }));
vi.mock('../../stores/session-store', () => ({ useSessionStore: (pick: any) => pick({ setActiveView: actions.setActiveView, setActiveSessionId: actions.setActiveSessionId, activeSessionId: null }) }));
vi.mock('../../stores/ai-panel-store', () => ({ useAiPanelStore: { getState: () => ({}) } }));
vi.mock('../../utils/file-path-links', () => ({ normalizeTowerFilePath: (s: string) => s, openTowerFile: vi.fn() }));

import { SchedulePanel } from './SchedulePanel';

const job = { id: 'automation-one', name: 'Daily check', jobType: 'ai_prompt', description: '', prompt: 'check', triggerType: 'manual', runCount: 2, enabled: true, status: 'idle', projectId: 'project-one', nextRunAt: null, onceAt: null, cronConfig: null, definitionJson: {}, createdAt: '2026-09-21T00:00:00Z', configUpdatedAt: '2026-09-21T00:00:00Z' };
function result(id: string, status: string, sessionId: string | null = null) {
  return { automationId: job.id, automationName: job.name, projectId: job.projectId, sessionId,
    run: { id, automationId: job.id, status, ranAt: '2026-09-21T00:00:00Z', summaryText: `${id} summary`, error: status === 'failed' ? 'Failure reason' : null, durationMs: 1000 } };
}
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); vi.stubGlobal('fetch', fetchMock);
  actions.confirm.mockResolvedValue(false);
  fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () =>
    String(url).includes('/results?') ? { items: [result('run-live', 'in_progress'), result('run-failed', 'failed'), result('run-success', 'success', 'session-safe')] }
      : String(url).endsWith('/api/automations') ? [job]
      : String(url).includes('/runs?') ? [] : { nodes: [], title: 'Process' } }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function chooseProjectAndResults() {
  fireEvent.change(screen.getByRole('combobox', { name: '' }), { target: { value: 'project-one' } });
  fireEvent.click(screen.getByRole('button', { name: 'resultsTitle' }));
  await screen.findByTestId('automation-result-run-live');
}

describe('SchedulePanel results', () => {
  it('asks for a project rather than querying an unscoped results endpoint', async () => {
    render(<SchedulePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'resultsTitle' }));
    expect(screen.getByText('resultsSelectProject')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/results?'))).toBe(false);
    await chooseProjectAndResults();
    expect(fetchMock).toHaveBeenCalledWith('/api/automations/results?limit=50&projectId=project-one', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('shows running as in progress and filters only attention states', async () => {
    render(<SchedulePanel />); await chooseProjectAndResults();
    expect(within(screen.getByTestId('automation-result-run-live')).getByText('resultInProgress')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'resultAttentionOnly' }));
    expect(screen.queryByTestId('automation-result-run-live')).toBeNull();
    expect(screen.getByTestId('automation-result-run-failed')).toBeTruthy();
    expect(screen.queryByTestId('automation-result-run-success')).toBeNull();
  });

  it('keeps sessionless results readable; only links the ACL-returned session and opens details', async () => {
    render(<SchedulePanel />); await chooseProjectAndResults();
    expect(within(screen.getByTestId('automation-result-run-failed')).queryByRole('button', { name: 'resultOpenSession' })).toBeNull();
    fireEvent.click(within(screen.getByTestId('automation-result-run-failed')).getByRole('button', { name: 'resultViewDetails' }));
    expect(await screen.findByText('runLog')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('automation-result-run-success')).getByRole('button', { name: 'resultOpenSession' }));
    expect(actions.setActiveSessionId).toHaveBeenCalledWith('session-safe');
    expect(actions.openChatTab).toHaveBeenCalledWith('session-safe');
  });

  it('shows fetch failure and retry without misleading empty state', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => String(url).includes('/results?') ? ++calls === 1 ? Promise.reject(new Error('offline')) : { items: [result('retry', 'failed')] } : String(url).endsWith('/api/automations') ? [job] : [] }));
    render(<SchedulePanel />);
    fireEvent.change(screen.getByRole('combobox', { name: '' }), { target: { value: 'project-one' } });
    fireEvent.click(screen.getByRole('button', { name: 'resultsTitle' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('resultsEmpty')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'resultsRetry' }));
    expect(await screen.findByTestId('automation-result-retry')).toBeTruthy();
  });

  it('keeps a reviewed draft in the registry but disables toggle and run-now', async () => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () =>
      String(url).endsWith('/api/automations') ? [{ ...job, enabled: false, definitionJson: { creationPlan: { status: 'draft' } } }] : [] }));
    render(<SchedulePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'recentlyRegistered' }));
    const list = within(document.querySelector('section')!);
    expect(await list.findByText('draftReview')).toBeTruthy();
    const row = list.getByText('Daily check').closest('article')!;
    expect(within(row).getByRole('button', { name: 'enable' }).hasAttribute('disabled')).toBe(true);
    expect(within(row).getByRole('button', { name: 'runNow' }).hasAttribute('disabled')).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/run-now'))).toBe(false);
  });

  it('ignores a late response from the previous project', async () => {
    let release!: (value: any) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () =>
      String(url).includes('projectId=project-one') ? pending : String(url).includes('projectId=project-two') ? { items: [result('second', 'success')] }
        : String(url).endsWith('/api/automations') ? [job] : [] }));
    render(<SchedulePanel />);
    const filter = screen.getByRole('combobox', { name: '' });
    fireEvent.change(filter, { target: { value: 'project-one' } });
    fireEvent.change(filter, { target: { value: 'project-two' } });
    fireEvent.click(screen.getByRole('button', { name: 'resultsTitle' }));
    expect(await screen.findByTestId('automation-result-second')).toBeTruthy();
    release({ items: [result('stale', 'failed')] });
    await waitFor(() => expect(screen.queryByTestId('automation-result-stale')).toBeNull());
  });

  it('ignores an obsolete project response after the filter changes', async () => {
    let resolveFirst!: (value: any) => void;
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () =>
      String(url).includes('projectId=project-one') ? new Promise((resolve) => { resolveFirst = resolve; })
        : String(url).includes('projectId=project-two') ? { items: [result('new-project', 'failed')] }
          : String(url).endsWith('/api/automations') ? [job] : [] }));
    render(<SchedulePanel />);
    fireEvent.change(screen.getByRole('combobox', { name: '' }), { target: { value: 'project-one' } });
    await waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
    fireEvent.change(screen.getByRole('combobox', { name: '' }), { target: { value: 'project-two' } });
    fireEvent.click(screen.getByRole('button', { name: 'resultsTitle' }));
    expect(await screen.findByTestId('automation-result-new-project')).toBeTruthy();
    resolveFirst({ items: [result('stale-project', 'failed')] });
    expect(screen.queryByTestId('automation-result-stale-project')).toBeNull();
  });

  it('does not display legacy spawned or admitted as a successful completion', async () => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => String(url).includes('/results?')
      ? { items: [result('legacy', 'spawned'), { ...result('uncertain', 'admitted'), executionStatus: 'uncertain' }] }
      : String(url).endsWith('/api/automations') ? [job] : [] }));
    render(<SchedulePanel />);
    fireEvent.change(screen.getByRole('combobox', { name: '' }), { target: { value: 'project-one' } });
    fireEvent.click(screen.getByRole('button', { name: 'resultsTitle' }));
    await screen.findByTestId('automation-result-legacy');
    expect(within(screen.getByTestId('automation-result-legacy')).queryByText('resultSucceeded')).toBeNull();
    expect(within(screen.getByTestId('automation-result-uncertain')).getByText('resultUncertain')).toBeTruthy();
  });

  it('requires explicit confirmation before run-now request', async () => {
    render(<SchedulePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'recentlyRegistered' }));
    const list = within(document.querySelector('section')!);
    fireEvent.click(await list.findByText('Daily check'));
    fireEvent.click(screen.getAllByRole('button', { name: /runNow/ })[0]);
    await waitFor(() => expect(actions.confirm).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/run-now'))).toBe(false);
  });
});
