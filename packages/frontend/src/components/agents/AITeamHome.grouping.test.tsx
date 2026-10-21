// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import type { Project } from '@tower/shared';
import { AITeamHome } from './AITeamHome';
import { useProjectStore } from '../../stores/project-store';
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('../../hooks/useDialog', () => ({ useConfirm: () => confirm }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ko' } }) }));
vi.mock('../../features/team-connections/TeamConnections', () => ({ TeamConnections: () => null }));
vi.mock('./TeamManagementPanel', () => ({ TeamManagementPanel: () => <div>permission management</div> }));
vi.mock('./VisualAgentTeams', () => ({ VisualAgentTeams: () => <div>visual board</div> }));
const projects = [
  { id: 'a', name: 'Alpha', archived: false, createdAt: '2026-01-01', agent: { displayName: 'Alpha', role: 'Writing' } },
  { id: 'b', name: 'Beta', archived: false, createdAt: '2026-02-01', agent: { displayName: 'Beta', role: 'Research' } },
] as Project[];
const gamma = { id: 'c', name: 'Gamma', lifecycleStatus: 'active', isMember: false, ownerUsername: 'owner', rootPath: '/not-rendered', sessionCount: 12345 };
function fixture(role = 'member', inventory = [gamma], directory = [{ projectId: 'a', name: 'Alpha', shortRole: 'Writing', access: 'available', contactName: null }]) {
  localStorage.setItem('token', `header.${btoa(JSON.stringify({ role, userId: 7 }))}.signature`);
  const request = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/agent-directory') return { ok: true, json: async () => ({ agents: directory }) };
    if (url.startsWith('/api/admin/agents?')) return { ok: true, json: async () => ({ agents: inventory }) };
    if (url.endsWith('/join')) return { ok: true, json: async () => ({ joined: true, role: 'member' }) };
    if (url === '/api/projects/c') return { ok: true, json: async () => ({ project: { ...projects[0], id: 'c', name: 'Gamma' } }) };
    if (url.startsWith('/api/projects/search?')) return { ok: true, json: async () => ({ projects: [] }) };
    throw new Error(`Unexpected request ${options?.method || 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', request);
  return request;
}
function home(isAdmin = false, onClose = vi.fn()) {
  const onOpenProjectHome = vi.fn();
  render(<AITeamHome onClose={onClose} isAdmin={isAdmin} projects={projects} sessions={[]} activeSessionId={null} onSelectSession={vi.fn()} onNewSession={vi.fn()} onOpenProjectHome={onOpenProjectHome} />);
  return onOpenProjectHome;
}
beforeEach(() => { confirm.mockReset(); confirm.mockResolvedValue(true); useProjectStore.setState({ projects: [...projects] }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('unions safe admin inventory and invited projects once, without a second directory or permission-team filter', async () => {
  fixture('admin'); home(true);
  expect(await screen.findByText('Gamma')).toBeInTheDocument();
  expect(screen.getAllByRole('heading', { name: 'Alpha' })).toHaveLength(1);
  expect(screen.queryByText('agentDirectory.title')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('aiTeamGrouping.label')).not.toBeInTheDocument();
  expect(screen.queryByText('/not-rendered')).not.toBeInTheDocument();
  expect(screen.queryByText('12345')).not.toBeInTheDocument();
  expect(screen.getByText('aiTeammateCount').querySelector('strong')).toHaveTextContent('3');
  expect(screen.getByText('inactiveTeammates').querySelector('strong')).toHaveTextContent('3');
});

it('uses the same search, sort and empty state for administrator-only cards', async () => {
  fixture('admin'); home(true); await screen.findByText('Gamma');
  expect([...document.querySelectorAll('article h2, article h3')].map(node => node.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
  fireEvent.change(screen.getByPlaceholderText('searchAiTeammates'), { target: { value: 'Gamma' } });
  expect(screen.getByText('Gamma')).toBeInTheDocument();
  expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  expect(screen.getByText('aiTeammateSearchSummary')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('searchAiTeammates'), { target: { value: 'Missing' } });
  expect(await screen.findByText('noAiTeammateSearchResults')).toBeInTheDocument();
  expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
});

it('opens exactly one view at a time and keeps permission management separate', async () => {
  const request = fixture('member'); home(); await waitFor(() => expect(request).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('tab', { name: 'aiTeamGrouping.visualTeamView' }));
  expect(screen.getByText('visual board')).toBeInTheDocument();
  expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'aiTeamGrouping.directoryView' }));
  expect(screen.queryByText('visual board')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
  expect(request.mock.calls.every(([url]) => !url.includes('/admin/'))).toBe(true);
});

it('supports operator participation through confirmation, existing join and normal ACL refetch', async () => {
  const request = fixture('operator'); const open = home();
  const card = (await screen.findByText('Gamma')).closest('article')!;
  fireEvent.click(within(card).getByRole('button', { name: 'aiTeamGrouping.join' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'c', name: 'Gamma' })));
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'aiTeamGrouping.joinConfirm' }));
  expect(request).toHaveBeenCalledWith('/api/admin/agents/c/join', expect.objectContaining({ method: 'POST' }));
  expect(request).toHaveBeenCalledWith('/api/projects/c', expect.anything());
  expect(useProjectStore.getState().projects.find(project => project.id === 'c')?.name).toBe('Gamma');
});

it('does not POST or open a project when participation is cancelled', async () => {
  confirm.mockResolvedValue(false); const request = fixture('admin'); const open = home(true);
  fireEvent.click(within((await screen.findByText('Gamma')).closest('article')!).getByRole('button'));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(request.mock.calls.some(([url]) => url.endsWith('/join') || url === '/api/projects/c')).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it('shows contact-only discovery to members without fetching admin inventory or joining', async () => {
  const request = fixture('member', [], [{ projectId: 'c', name: 'Gamma', shortRole: '', access: 'contact', contactName: 'owner' }]);
  home();
  fireEvent.click(within((await screen.findByText('Gamma')).closest('article')!).getByRole('button', { name: 'agentDirectory.introduction' }));
  expect(screen.getByText('agentDirectory.askContact')).toBeInTheDocument();
  expect(confirm).not.toHaveBeenCalled();
  expect(request.mock.calls.every(([url]) => !url.includes('/admin/'))).toBe(true);
});

it('fails closed when the normal project ACL rejects entry after a successful join', async () => {
  const request = fixture('admin'); const open = home(true);
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async (url: string, options?: RequestInit) => url === '/api/projects/c' ? { ok: false, json: async () => ({ error: 'forbidden' }) } : implementation(url, options));
  fireEvent.click(within((await screen.findByText('Gamma')).closest('article')!).getByRole('button'));
  expect(await screen.findByRole('alert')).toHaveTextContent('agentDirectory.entryError');
  expect(open).not.toHaveBeenCalled();
  expect(useProjectStore.getState().projects.some(project => project.id === 'c')).toBe(false);
});

it('does not fetch or open a project when the join endpoint denies participation', async () => {
  const request = fixture('admin'); const open = home(true);
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/join') ? { ok: false, json: async () => ({ error: 'forbidden' }) } : implementation(url, options));
  fireEvent.click(within((await screen.findByText('Gamma')).closest('article')!).getByRole('button'));
  expect(await screen.findByRole('alert')).toHaveTextContent('agentDirectory.entryError');
  expect(request.mock.calls.some(([url]) => url === '/api/projects/c')).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it('offers retry without exposing nonmembers when administrator inventory is unavailable', async () => {
  const request = fixture('operator');
  const implementation = request.getMockImplementation()!;
  request.mockImplementation(async (url: string, options?: RequestInit) => url.startsWith('/api/admin/agents?') ? { ok: false, json: async () => ({}) } : implementation(url, options));
  home();
  expect(await screen.findByText('aiTeamGrouping.participationUnavailable')).toBeInTheDocument();
  expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
});

it('provides a keyboard-focusable close action without opening a teammate home', () => {
  const onClose = vi.fn();
  const onOpenProjectHome = home(false, onClose);
  const close = screen.getByRole('button', { name: 'closeAiTeam' });
  expect(close).toHaveTextContent('returnToChat');
  expect(close).toHaveAttribute('type', 'button');
  close.focus();
  expect(close).toHaveFocus();
  fireEvent.click(close);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenProjectHome).not.toHaveBeenCalled();
});
