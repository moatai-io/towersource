// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project } from '@tower/shared';
import { VisualAgentTeams } from './VisualAgentTeams';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, vars?: { name: string }) => vars ? `${key}:${vars.name}` : key }) }));
vi.mock('../../features/agent-profile/AgentIdentityAvatar', () => ({ AgentIdentityAvatar: () => null }));
const projects = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] as Project[];
const initial = { version: 2, teams: [{ id: 'design', name: 'Design' }], assignments: { a: 'design' }, canManage: true };
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('moves an agent through the visual API with expected version, never authority teams', async () => {
 const request = vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({ ...initial, version: 3, assignments: { a: 'design', b: 'design' } }));
 vi.stubGlobal('fetch', request); render(<VisualAgentTeams projects={projects} />);
 fireEvent.change(await screen.findByLabelText('visualAgentTeams.move:Beta'), { target: { value: 'design' } });
 await waitFor(() => expect(screen.getByLabelText('visualAgentTeams.move:Beta')).toHaveValue('design'));
 expect(request.mock.calls[1][0]).toBe('/api/agent-visual-teams');
 expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ expectedVersion: 2, command: { kind: 'assign', projectId: 'b', teamId: 'design' } });
 expect(request.mock.calls.every(call => call[0] === '/api/agent-visual-teams')).toBe(true);
});
it('creates a named team and displays the server response', async () => {
 const request = vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({ ...initial, version: 3, teams: [...initial.teams, { id: 'sales', name: 'Sales' }] }));
 vi.stubGlobal('fetch', request); render(<VisualAgentTeams projects={projects} />);
 fireEvent.change(await screen.findByLabelText('visualAgentTeams.teamName'), { target: { value: ' Sales ' } });
 fireEvent.click(screen.getByText('visualAgentTeams.create'));
 await screen.findByRole('heading', { name: /Sales/ });
 expect(JSON.parse(request.mock.calls[1][1].body).command).toEqual({ kind: 'create', name: 'Sales' });
});
it('reloads on version conflict rather than overwriting concurrent edits', async () => {
 const request = vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({}, 409)).mockResolvedValueOnce(response({ ...initial, version: 3 }));
 vi.stubGlobal('fetch', request); render(<VisualAgentTeams projects={projects} />);
 fireEvent.change(await screen.findByLabelText('visualAgentTeams.move:Beta'), { target: { value: 'design' } });
 expect(await screen.findByRole('alert')).toHaveTextContent('visualAgentTeams.conflict');
 await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
});
it('does not show unassigned agents when the load fails', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, 503))); render(<VisualAgentTeams projects={projects} />);
 await screen.findByRole('alert'); expect(screen.queryByText('Beta')).not.toBeInTheDocument();
 expect(screen.queryByText('visualAgentTeams.unassigned')).not.toBeInTheDocument();
});
it('read-only viewers cannot create or move teams', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...initial, canManage: false }))); render(<VisualAgentTeams projects={projects} />);
 await screen.findByText('Beta'); expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
 expect(screen.queryByText('visualAgentTeams.create')).not.toBeInTheDocument();
});
it('requires reload after an uncertain save instead of showing stale moves as safe', async () => {
 const request = vi.fn().mockResolvedValueOnce(response(initial)).mockRejectedValueOnce(new Error('network'));
 vi.stubGlobal('fetch', request); render(<VisualAgentTeams projects={projects} />);
 fireEvent.change(await screen.findByLabelText('visualAgentTeams.move:Beta'), { target: { value: 'design' } });
 await screen.findByText('visualAgentTeams.saveError');
 expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
 expect(screen.getByText('visualAgentTeams.retry')).toBeInTheDocument();
});
it('does not render a team editor before loading finishes', () => {
 vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));
 render(<VisualAgentTeams projects={projects} />);
 expect(screen.getByRole('status')).toHaveTextContent('visualAgentTeams.loading');
 expect(screen.queryByText('visualAgentTeams.unassigned')).not.toBeInTheDocument();
 expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
