// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import chatEn from '../../locales/en/chat.json';
import SecureInputBlock from './SecureInputBlock';

void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { chat: chatEn } },
  interpolation: { escapeValue: false },
});

function renderSecureInput(raw: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SecureInputBlock raw={raw} fallbackCode="" />
    </I18nextProvider>,
  );
}

const enqueueMessage = vi.fn();
vi.mock('../../stores/chat-store', () => ({
  useChatStore: { getState: () => ({ enqueueMessage }) },
}));

let sessionState: { activeSessionId: string | null; sessions: Array<{ id: string; projectId: string | null }> };

vi.mock('../../stores/session-store', () => ({
  useSessionStore: (selector: (state: any) => unknown) => selector(sessionState),
}));

function spec(scope: 'personal' | 'project' | 'workspace') {
  return JSON.stringify({
    target: 'credential-vault',
    fields: [{ key: 'TEST_API_KEY', label: 'Test API key', required: true }],
    credential: {
      id: `test-${scope}`,
      provider: 'test',
      displayName: `Test ${scope}`,
      secretName: 'TEST_API_KEY',
      envName: 'TEST_API_KEY',
      scope,
      grantToCurrentProject: scope === 'project',
    },
  });
}

beforeEach(() => {
  enqueueMessage.mockReset();
  sessionState = {
    activeSessionId: 'session-1',
    sessions: [{ id: 'session-1', projectId: 'project-1' }],
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SecureInputBlock Credential Vault endpoint routing', () => {
  it('isolates secret fields from browser credential autofill heuristics', () => {
    const { container } = renderSecureInput(spec('project'));
    const secretInput = screen.getByPlaceholderText('TEST_API_KEY');
    const secureBlock = secretInput.closest('[data-form-type="other"]');

    expect(secretInput).toHaveAttribute('type', 'password');
    expect(secretInput).toHaveAttribute('name', 'tower-secret-value-TEST_API_KEY');
    expect(secretInput).toHaveAttribute('autocomplete', 'new-password');
    expect(secretInput).toHaveAttribute('data-1p-ignore', 'true');
    expect(secretInput).toHaveAttribute('data-bwignore', 'true');
    expect(secretInput).toHaveAttribute('data-lpignore', 'true');
    expect(secretInput).toHaveAttribute('data-protonpass-ignore', 'true');
    expect(secureBlock).toBeInTheDocument();
    expect(container.querySelector('[data-form-type="other"]')).toHaveAttribute('data-1p-ignore', 'true');
  });

  it('uses the personal credential endpoint for personal scope', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderSecureInput(spec('personal'));
    fireEvent.change(screen.getByPlaceholderText('TEST_API_KEY'), { target: { value: 'secret-test-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Vault' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/credential-vault/my/credentials/api-key');
  });

  it('uses the current Agent credential endpoint for project scope', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderSecureInput(spec('project'));
    fireEvent.change(screen.getByPlaceholderText('TEST_API_KEY'), { target: { value: 'secret-test-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Vault' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/credential-vault/projects/project-1/credentials/api-key');
  });

  it('recovers the active project from the session endpoint when the session list is not hydrated', async () => {
    sessionState = { activeSessionId: 'session-1', sessions: [] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === '/api/sessions/session-1') {
        return { ok: true, json: async () => ({ id: 'session-1', projectId: 'project-from-server' }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderSecureInput(spec('project'));
    fireEvent.change(screen.getByPlaceholderText('TEST_API_KEY'), { target: { value: 'secret-test-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Vault' }));

    await waitFor(() => expect(screen.getByText(/1 key was saved/)).toBeInTheDocument());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/sessions/session-1',
      '/api/credential-vault/projects/project-from-server/credentials/api-key',
    ]);
  });

  it('does not rotate the credential when a requested project grant cannot resolve a project', async () => {
    sessionState = { activeSessionId: 'session-1', sessions: [] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'session-1', projectId: null }),
    } as Response);

    renderSecureInput(spec('project'));
    fireEvent.change(screen.getByPlaceholderText('TEST_API_KEY'), { target: { value: 'secret-test-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Vault' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1', expect.any(Object));
    expect(screen.getByText(/not connected to a project/i)).toBeInTheDocument();
  });

  it('keeps workspace scope on the admin credential endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderSecureInput(spec('workspace'));
    fireEvent.change(screen.getByPlaceholderText('TEST_API_KEY'), { target: { value: 'secret-test-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Vault' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/credential-vault/credentials/api-key');
  });
});

 describe('secure credential continuation', () => {
  it('queues one secret-free continuation after all fields save, even if the active session changes', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate;
      return { ok: true, json: async () => ({}) } as Response;
    });
    const multi = JSON.parse(spec('project'));
    multi.fields.push({ key: 'SECOND_KEY', required: true });
    renderSecureInput(JSON.stringify(multi));
    fireEvent.change(screen.getByPlaceholderText('TEST_API_KEY'), { target: { value: 'private-first-value' } });
    fireEvent.change(screen.getByPlaceholderText('SECOND_KEY'), { target: { value: 'private-second-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Vault' }));
    expect(enqueueMessage).not.toHaveBeenCalled();
    sessionState.activeSessionId = 'session-2';
    finish();
    await waitFor(() => expect(enqueueMessage).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(enqueueMessage).toHaveBeenCalledWith('session-1', chatEn.secureInputResumeRequest);
    expect(JSON.stringify(enqueueMessage.mock.calls)).not.toContain('private-');
  });

  it('does not continue after a partial save failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Save rejected' }) } as Response);
    const multi = JSON.parse(spec('project'));
    multi.fields.push({ key: 'SECOND_KEY', required: true });
    renderSecureInput(JSON.stringify(multi));
    fireEvent.change(screen.getByPlaceholderText('TEST_API_KEY'), { target: { value: 'private-first-value' } });
    fireEvent.change(screen.getByPlaceholderText('SECOND_KEY'), { target: { value: 'private-second-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Vault' }));
    await screen.findByText('Save rejected');
    expect(enqueueMessage).not.toHaveBeenCalled();
  });
});
