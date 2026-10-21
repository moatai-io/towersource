// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { AutomationCreatePanel } from './AutomationCreatePanel';
const fetchMock = vi.fn();
const created = vi.fn();
const props = { projects: [{ id: 'p1', name: 'Agent One' }], sourceSessionId: 's1', onCancel: vi.fn(), onCreated: created };
const plan = { kind: 'plan', automation: { id: 'a1', prompt: '매일 오전 9시에 요약해줘', triggerType: 'cron', timezone: 'Asia/Seoul', cronConfig: { type: 'daily', hour: 9, minute: 0 }, model: 'preset/core' }, proposalHash: 'a'.repeat(64), expiresAt: '2030-01-01T00:00:00Z', projectName: 'Agent One', runtimeModel: 'litellm-responses/core', modelMode: 'core', nextRunAt: '2030-01-01T00:00:00Z', nextRunTimes: ['2030-01-01T00:00:00Z', '2030-01-02T00:00:00Z', '2030-01-03T00:00:00Z'], readiness: { workspace: 'active', createPermission: 'allowed', modelSelection: 'selectable', agentExecutionAccess: 'allowed', workspacePath: 'accessible', executionAndProvider: 'not_verified', dataAndWriteScope: 'not_verified' }, warnings: ['synthetic warning'] };
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockResolvedValue({ ok: true, json: async () => plan }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function preview() {
  fireEvent.change(screen.getByLabelText('planRequest'), { target: { value: '매일 오전 9시에 요약해줘' } });
  fireEvent.click(screen.getByRole('button', { name: 'planPreview' }));
  await screen.findByText('planReviewTitle');
}
describe('creation review interaction', () => {
  it('previews without running, requires checkbox, and activates only the exact reviewed hash', async () => {
    render(<AutomationCreatePanel {...props} />); await preview();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/automations/creation-plans');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ projectId: 'p1', modelMode: 'core' });
    fireEvent.click(screen.getByRole('button', { name: 'planActivate' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('checkbox'));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ automation: { id: 'a1', enabled: true } }) });
    fireEvent.click(screen.getByRole('button', { name: 'planActivate' }));
    await waitFor(() => expect(created).toHaveBeenCalledWith({ id: 'a1', enabled: true }));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/automations/creation-plans/a1/activate');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ confirmed: true, proposalHash: plan.proposalHash });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('run-now'))).toBe(false);
  });
  it('invalidates old plan and confirmation when input changes', async () => {
    render(<AutomationCreatePanel {...props} />); await preview(); fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('planRequest'), { target: { value: '새 업무' } });
    expect(screen.queryByRole('button', { name: 'planActivate' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(created).not.toHaveBeenCalled();
  });
  it('shows clarification/error and preserves the plan for activation retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ kind: 'clarification', message: 'Choose a time' }) });
    render(<AutomationCreatePanel {...props} />);
    fireEvent.change(screen.getByLabelText('planRequest'), { target: { value: '요약해줘' } });
    fireEvent.click(screen.getByRole('button', { name: 'planPreview' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Choose a time');
    fireEvent.click(screen.getByRole('button', { name: 'planPreview' })); await screen.findByText('planReviewTitle');
    fireEvent.click(screen.getByRole('checkbox'));
    fetchMock.mockResolvedValueOnce({ ok: false, statusText: 'Conflict', json: async () => ({ error: 'expired plan' }) });
    fireEvent.click(screen.getByRole('button', { name: 'planActivate' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'expired plan');
    expect(screen.getByText('planReviewTitle')).toBeTruthy();
    expect(created).not.toHaveBeenCalled();
  });
  it('passes session-model intent only when chosen and disables absent session', async () => {
    render(<AutomationCreatePanel {...props} />);
    fireEvent.change(screen.getByLabelText('planModel'), { target: { value: 'session' } });
    await preview();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ modelMode: 'session', sourceSessionId: 's1' });
  });
  it('renders occurrence timestamps in the plan timezone rather than the browser timezone', async () => {
    render(<AutomationCreatePanel {...props} />);
    await preview();
    const first = screen.getByTestId('plan-next-runs').querySelector('li')?.textContent || '';
    expect(first).toContain('09:00'); // 00:00Z is 09:00 in Asia/Seoul.
    expect(first).toMatch(/GMT\+9|KST/);
  });
  it('does not invent occurrences for manual execution', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...plan, automation: { ...plan.automation, triggerType: 'manual' }, nextRunAt: null, nextRunTimes: [] }) });
    render(<AutomationCreatePanel {...props} />);
    await preview();
    expect(screen.queryByTestId('plan-next-runs')).toBeNull();
    expect(screen.getByText('planManualNoNext')).toBeTruthy();
    expect(screen.getByText('planReadyUnverified')).toBeTruthy();
  });
  it('does not activate a plan if required readiness evidence is missing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...plan, readiness: { ...plan.readiness, agentExecutionAccess: 'not_verified' } }) });
    render(<AutomationCreatePanel {...props} />);
    await preview();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('planReadinessUnavailable')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'planActivate' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('resumes a draft request and renders human-readable daily schedule, not JSON', async () => {
    render(<AutomationCreatePanel {...props} initialRequest="원래 업무" />);
    expect((screen.getByLabelText('planRequest') as HTMLTextAreaElement).value).toBe('원래 업무');
    fireEvent.click(screen.getByRole('button', { name: 'planPreview' })); await screen.findByText('planReviewTitle');
    expect(screen.getByText(/planFrequency.daily.*09:00/)).toBeTruthy();
    expect(screen.getByTestId('plan-next-runs').querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('planReadyChecked')).toBeTruthy();
    expect(screen.getByText('planReadyUnverified')).toBeTruthy();
    expect(screen.queryByText(/"type":"daily"/)).toBeNull();
  });
});
