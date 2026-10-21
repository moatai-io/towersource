// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdministratorParticipation } from './AdministratorParticipation';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const identity = vi.hoisted(() => ({ role: 'operator' }));
vi.mock('../../utils/auth', () => ({ getCurrentRole: () => identity.role, getCurrentUserId: () => 7 }));
const participant = { userId: 7, username: 'Operator' };
const response = (participants: typeof participant[] = []) => ({ ok: true, json: async () => ({ participants }) });
const mutation = { ok: true, json: async () => ({ joined: true }) };
beforeEach(() => { identity.role = 'operator'; localStorage.setItem('token', 'synthetic'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mutations = (request: ReturnType<typeof vi.fn>) => request.mock.calls.filter(([, options]) => options?.method);

describe('administrator participation on actual Workspace entry', () => {
  it('joins automatically on entry and refreshes the read audience without showing names/notices', async () => {
    const request = vi.fn().mockResolvedValueOnce(response())
      .mockResolvedValueOnce(mutation).mockResolvedValueOnce(response([participant]));
    const changed = vi.fn();
    window.addEventListener('tower-administrator-participation-changed', changed);
    vi.stubGlobal('fetch', request);
    render(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    await screen.findByText('administratorParticipation.leave');
    expect(request.mock.calls[1][0]).toBe('/api/administrator-participation/project/project-a');
    expect(request.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{"confirmed":true}' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('administratorParticipation.join')).toBeNull();
    expect(screen.queryByText(/Operator/)).toBeNull();
    expect(screen.queryByText('administratorParticipation.notice')).toBeNull();
    window.removeEventListener('tower-administrator-participation-changed', changed);
  });

  it('does not participate or even fetch a directory/profile preview', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const { rerender } = render(<AdministratorParticipation targetId="project-a" />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByRole('region')).toBeNull();
    request.mockResolvedValue(response([participant]));
    rerender(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    await screen.findByText('administratorParticipation.leave');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['member', 'admin', 'viewer'])('does not fetch or join for %s', role => {
    identity.role = role;
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    render(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not duplicate participation on refresh or rerender when already joined', async () => {
    const request = vi.fn().mockResolvedValue(response([participant])); vi.stubGlobal('fetch', request);
    const first = render(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    await screen.findByText('administratorParticipation.leave');
    first.rerender(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    first.unmount();
    render(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    await screen.findByText('administratorParticipation.leave');
    expect(request).toHaveBeenCalledTimes(2);
    expect(mutations(request)).toHaveLength(0);
  });

  it('does not repeat an entry mutation under StrictMode effect replay', async () => {
    let joined = false;
    const request = vi.fn().mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') { joined = true; return mutation; }
      return response(joined ? [participant] : []);
    });
    vi.stubGlobal('fetch', request);
    render(<StrictMode><AdministratorParticipation targetId="project-a" workspaceEntered /></StrictMode>);
    await screen.findByText('administratorParticipation.leave');
    expect(mutations(request)).toHaveLength(1);
  });

  it('leaves explicitly and never rejoins from the resulting state update or rerender', async () => {
    const request = vi.fn().mockResolvedValueOnce(response([participant]))
      .mockResolvedValueOnce(mutation).mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', request);
    const view = render(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    fireEvent.click(await screen.findByText('administratorParticipation.leave'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    view.rerender(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    expect(mutations(request).map(([, options]) => options.method)).toEqual(['DELETE']);
    expect(screen.queryByRole('button')).toBeNull();
    view.unmount();
    expect(mutations(request)).toHaveLength(1); // Unmount never leaves.
  });

  it('does not undo persisted leave when the follow-up list request fails', async () => {
    const request = vi.fn().mockResolvedValueOnce(response([participant]))
      .mockResolvedValueOnce(mutation).mockResolvedValueOnce({ ok: false });
    vi.stubGlobal('fetch', request);
    render(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    fireEvent.click(await screen.findByText('administratorParticipation.leave'));
    await screen.findByRole('alert');
    expect(screen.queryByText('administratorParticipation.leave')).toBeNull();
    expect(mutations(request).map(([, options]) => options.method)).toEqual(['DELETE']);
  });

  it('keeps channels explicitly opt-in', async () => {
    const request = vi.fn().mockResolvedValueOnce(response())
      .mockResolvedValueOnce(mutation).mockResolvedValueOnce(response([participant]));
    vi.stubGlobal('fetch', request);
    render(<AdministratorParticipation targetId="channel-a" scope="channel" workspaceEntered />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(mutations(request)).toHaveLength(0);
    fireEvent.click(screen.getByText('administratorParticipation.join'));
    await screen.findByText('administratorParticipation.leave');
    expect(mutations(request)[0][0]).toBe('/api/administrator-participation/channel/channel-a');
  });

  it.each(['read', 'write'])('does not claim participation after %s failure', async failure => {
    const request = failure === 'read' ? vi.fn().mockResolvedValue({ ok: false })
      : vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce({ ok: false });
    vi.stubGlobal('fetch', request);
    render(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    await screen.findByRole('alert');
    expect(screen.queryByText('administratorParticipation.leave')).toBeNull();
  });

  it('does not join an old target whose lookup finishes after navigation', async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    const request = vi.fn().mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(response([participant]));
    vi.stubGlobal('fetch', request);
    const view = render(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    view.rerender(<AdministratorParticipation targetId="project-b" workspaceEntered />);
    await screen.findByText('administratorParticipation.leave');
    await act(async () => { resolveOld(response()); });
    expect(mutations(request)).toHaveLength(0);
  });

  it('does not apply a previous target mutation result to the new target', async () => {
    let resolveOld!: (value: typeof mutation) => void;
    const request = vi.fn().mockResolvedValueOnce(response([participant]))
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(response([participant]));
    vi.stubGlobal('fetch', request);
    const view = render(<AdministratorParticipation targetId="project-a" workspaceEntered />);
    fireEvent.click(await screen.findByText('administratorParticipation.leave'));
    view.rerender(<AdministratorParticipation targetId="project-b" workspaceEntered />);
    await screen.findByText('administratorParticipation.leave');
    await act(async () => { resolveOld(mutation); });
    expect(request).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('administratorParticipation.leave')).not.toBeNull();
  });
});
