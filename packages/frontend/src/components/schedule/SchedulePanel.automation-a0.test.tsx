// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({ addSession: vi.fn(), setContext: vi.fn(), addThread: vi.fn(), setActiveThreadId: vi.fn(), setMessages: vi.fn(), setPendingQuestion: vi.fn(), setOpen: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../hooks/useDialog', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../stores/project-store', () => ({ useProjectStore: (pick: any) => pick({ projects: [] }) }));
vi.mock('../../stores/file-store', () => ({ useFileStore: (pick: any) => pick({ openSystemTab: vi.fn() }) }));
vi.mock('../../stores/session-store', () => ({ useSessionStore: (pick: any) => pick({ setActiveView: vi.fn(), activeSessionId: null, addSession: actions.addSession }) }));
vi.mock('../../stores/ai-panel-store', () => ({ useAiPanelStore: { getState: () => actions } }));
vi.mock('../../utils/file-path-links', () => ({ normalizeTowerFilePath: (s: string) => s, openTowerFile: vi.fn() }));

import { SchedulePanel } from './SchedulePanel';

const manual = {
  id: 'manual-never-run', name: 'Manual check', description: '', prompt: 'check', jobType: 'ai_prompt',
  triggerType: 'manual', runCount: 0, enabled: true, status: 'idle', projectId: null,
  nextRunAt: null, onceAt: null, cronConfig: null, definitionJson: {},
  createdAt: '2026-09-21T00:00:00Z', configUpdatedAt: '2026-09-21T00:00:00Z',
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => String(url).endsWith('/editor-thread')
      ? { session: { id: 'editor-1', parentSessionId: null, updatedAt: '2026-09-21T00:00:00Z' }, created: true }
      : String(url).includes('/runs?') ? [] : String(url).endsWith('/api/automations') ? [manual] : {},
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('SchedulePanel manual definition and edit flow', () => {
  it('shows a never-run manual definition in registered list, not upcoming runs', async () => {
    const view = render(<SchedulePanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/automations', expect.anything()));
    const list = within(view.container.querySelector('section')!);
    expect(list.queryByText('Manual check')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'recentlyRegistered' }));
    expect(await list.findByText('Manual check')).not.toBeNull();
    fireEvent.click(list.getByText('Manual check'));
    expect(screen.getByRole('button', { name: 'reviewChanges' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
  });

  it('opens the existing review conversation instead of saving an unsent form', async () => {
    const view = render(<SchedulePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'recentlyRegistered' }));
    fireEvent.click(await within(view.container.querySelector('section')!).findByText('Manual check'));
    fireEvent.click(screen.getByRole('button', { name: 'reviewChanges' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/automations/manual-never-run/editor-thread', expect.objectContaining({ method: 'POST' })));
    expect(actions.setOpen).toHaveBeenCalledWith(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/change-intents'))).toHaveLength(0);
  });
});
