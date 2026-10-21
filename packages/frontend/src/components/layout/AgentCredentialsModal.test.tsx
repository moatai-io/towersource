// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCredentialsModal } from './AgentCredentialsModal';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useDialog', () => ({ useConfirm: () => confirm, usePrompt: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../i18n', () => ({ default: { language: 'en', t: (key: string) => key } }));
vi.mock('../../utils/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('./AgentConnectionsPanel', () => ({ AgentConnectionsPanel: () => <div>shared-catalog</div> }));
const credential = { id: 'gws-test', provider: 'google', display_name: 'Test Google', enabled: true, updated_at: '', rotated_at: null, allowedActions: { replacementAction: 'reauth' } };
let requests: Array<{ url: string; init?: RequestInit }>;
beforeEach(() => {
  requests = [];
  credential.enabled = true;
  confirm.mockReset().mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ credentials: [credential] }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() { render(<AgentCredentialsModal project={{ id: 'agent-a', name: 'Agent A' } as any} onClose={() => {}} />); }

describe('Agent connection lifecycle', () => {
  it('keeps the API form hidden until Add and API key are selected', async () => {
    mount();
    await screen.findByText('Test Google');
    expect(screen.queryByPlaceholderText('agentCredentials.valuePlaceholder')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('agentCredentials.addConnection'));
    fireEvent.click(screen.getByText('agentCredentials.method_api'));
    expect(screen.getByPlaceholderText('agentCredentials.valuePlaceholder')).toBeInTheDocument();
    fireEvent.click(screen.getByText('agentCredentials.cancel'));
    expect(screen.queryByPlaceholderText('agentCredentials.valuePlaceholder')).not.toBeInTheDocument();
  });
  it('stops a connection using the canonical scoped PATCH route', async () => {
    mount();
    fireEvent.click(await screen.findByText('agentCredentials.disable'));
    await waitFor(() => expect(requests.some(({ url, init }) => url === '/api/credential-vault/projects/agent-a/credentials/gws-test' && init?.method === 'PATCH' && init.body === '{"enabled":false}')).toBe(true));
  });
  it('resumes a paused connection', async () => {
    credential.enabled = false;
    mount();
    fireEvent.click(await screen.findByText('agentCredentials.enable'));
    await waitFor(() => expect(requests.some(({ init }) => init?.method === 'PATCH' && init.body === '{"enabled":true}')).toBe(true));
  });
  it('deletes only after confirmation', async () => {
    mount();
    fireEvent.click(await screen.findByText('agentCredentials.delete'));
    await waitFor(() => expect(requests.some(({ init }) => init?.method === 'DELETE')).toBe(true));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  });
  it('does not delete when confirmation is cancelled', async () => {
    confirm.mockResolvedValue(false);
    mount();
    fireEvent.click(await screen.findByText('agentCredentials.delete'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(requests.some(({ init }) => init?.method === 'DELETE')).toBe(false);
  });
  it('refreshes the management list when an imported connection changes', async () => {
    mount();
    await screen.findByText('Test Google');
    const before = requests.length;
    window.dispatchEvent(new CustomEvent('tower-agent-credentials-changed', { detail: { projectId: 'agent-a' } }));
    await waitFor(() => expect(requests.length).toBeGreaterThan(before));
  });
});
