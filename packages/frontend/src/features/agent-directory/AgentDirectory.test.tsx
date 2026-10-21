// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@tower/shared';
import { AgentDirectory } from './AgentDirectory';
import { AgentDirectoryVisibility } from './AgentDirectoryVisibility';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, data?: any) => data?.name ? `${key}: ${data.name}` : key, i18n: { language: 'ko' } }) }));
vi.mock('../../utils/auth', () => ({ getCurrentRole: () => 'operator' }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const row = { projectId: 'agent', name: 'Research', shortRole: 'Research briefs', contactName: 'Owner', access: 'contact' };
const project = { id: 'agent', name: 'Research', archived: 0, rootPath: '/protected' } as Project;
const response = (data: any, ok = true) => ({ ok, json: async () => data }) as Response;
describe('minimal directory', () => {
  it('opens only an introduction for a locked member and never loads a workspace', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ agents: [row] }));
    const open = vi.fn(); render(<AgentDirectory projects={[project]} onOpenProject={open} />);
    await screen.findByText('Research'); fireEvent.click(screen.getByRole('button', { name: 'agentDirectory.introduction' }));
    expect(screen.getByRole('status')).toHaveTextContent('agentDirectory.askContact: Owner');
    expect(open).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.body).not.toHaveTextContent('/protected');
  });
  it('opens the listed Introduction agent only after rechecking project membership', async () => {
    const intro = { ...project, id: 'intro', name: 'Introduction' };
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ agents: [{ ...row, projectId: 'intro', name: 'Introduction', access: 'available' }] }))
      .mockResolvedValueOnce(response([intro]));
    const open = vi.fn(); render(<AgentDirectory projects={[]} onOpenProject={open} />);
    await screen.findByText('Introduction');
    fireEvent.click(screen.getByRole('button', { name: 'agentDirectory.open' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(intro));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/agent-directory', '/api/projects']);
  });
  it('rechecks existing project ACL before operator entry, without doing participation itself', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ agents: [{ ...row, access: 'enter' }] })).mockResolvedValueOnce(response([project]));
    const open = vi.fn(); render(<AgentDirectory projects={[]} onOpenProject={open} />);
    await screen.findByText('agentDirectory.access.enter'); fireEvent.click(screen.getByRole('button', { name: 'agentDirectory.open' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(project));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/agent-directory', '/api/projects']);
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('fails closed when membership was revoked despite a cached accessible Project', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ agents: [{ ...row, access: 'available' }] })).mockResolvedValueOnce(response([]));
    const open = vi.fn(); render(<AgentDirectory projects={[project]} onOpenProject={open} />);
    await screen.findByText('Research'); fireEvent.click(screen.getByRole('button', { name: 'agentDirectory.open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('agentDirectory.entryError'); expect(open).not.toHaveBeenCalled();
  });
  it('does not merge hidden cached projects into company results; searches only discovery metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ agents: [row] }));
    render(<AgentDirectory projects={[{ ...project, name: 'Hidden name' }]} onOpenProject={vi.fn()} />);
    await screen.findByText('Research'); expect(screen.queryByText('Hidden name')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } });
    expect(screen.queryByText('Research')).not.toBeInTheDocument(); expect(screen.getByText('agentDirectory.empty')).toBeInTheDocument();
  });
  it('reports errors and supports a read-only retry', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({}, false)).mockResolvedValueOnce(response({ agents: [] }));
    render(<AgentDirectory projects={[]} onOpenProject={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('agentDirectory.error');
    fireEvent.click(screen.getByRole('button', { name: 'agentDirectory.refresh' }));
    await screen.findByText('agentDirectory.empty'); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
describe('explicit disclosure settings', () => {
  it('requires reviewing a disclosure warning and confirming before listing a legacy agent', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ visibility: 'unlisted' })).mockResolvedValueOnce(response({ visibility: 'listed' }));
    render(<AgentDirectoryVisibility project={project} />);
    expect(fetch).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'agentDirectory.visibility.title' }));
    await screen.findByRole('combobox'); fireEvent.change(screen.getByRole('combobox'), { target: { value: 'listed' } });
    expect(screen.getByText('agentDirectory.visibility.publishWarning')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'agentDirectory.visibility.save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'agentDirectory.visibility.save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ visibility: 'listed', confirmed: true }) });
  });
  it('supports explicit confidential hiding without mentioning ACL changes as a side effect', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ visibility: 'listed' }));
    render(<AgentDirectoryVisibility project={project} />); fireEvent.click(screen.getByRole('button', { name: 'agentDirectory.visibility.title' }));
    await screen.findByRole('combobox'); fireEvent.change(screen.getByRole('combobox'), { target: { value: 'confidential' } });
    expect(screen.getByText('agentDirectory.visibility.hideWarning')).toBeInTheDocument();
  });
});

it('integrates discovery cards without duplicating accessible projects or the directory heading', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agents: [
    { projectId: 'owned', name: 'Owned agent', access: 'available' },
    { projectId: 'discover', name: 'Discover agent', access: 'enter' },
  ] }) }));
  render(<AgentDirectory integrated projects={[{ id: 'owned' } as Project]} onOpenProject={vi.fn()} />);
  expect(await screen.findByText('Discover agent')).toBeInTheDocument();
  expect(screen.queryByText('Owned agent')).not.toBeInTheDocument();
  expect(screen.queryByText('agentDirectory.title')).not.toBeInTheDocument();
  expect(screen.getByText('aiTeamGrouping.enter')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
});
