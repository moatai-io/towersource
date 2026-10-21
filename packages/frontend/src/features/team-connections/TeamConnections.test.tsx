// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project } from '@tower/shared';
import { TeamConnections } from './TeamConnections';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const projects = [{ id: 'a', name: 'Research', archived: 0 }, { id: 'b', name: 'Finance', archived: 0 }, { id: 'old', archived: 1 }, { id: 'system', systemKey: 'helper' }] as Project[];
function mock(fail = false) { return vi.spyOn(globalThis, 'fetch').mockImplementation(async url => ({ ok: !(fail && String(url).includes('/b/')), json: async () => String(url).includes('/users/') ? [{ id: 1, username: 'Alice' }, { id: 2, username: 'Bob' }] : [{ userId: 1, username: 'Alice', role: 'member' }] }) as Response); }
it('shows a stable people-to-AI network with accessible nodes', async () => {
  mock(); const onOpenProject = vi.fn(); const { container } = render(<TeamConnections projects={projects} onOpenProject={onOpenProject} />);
  await screen.findByRole('img');
  expect(container.querySelectorAll('[data-connection]')).toHaveLength(2);
  expect(container.querySelector('[data-connection="1-a"]')).not.toBeNull();
  expect(container.querySelector('[data-connection="2-a"]')).toBeNull();
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 720 300');
  expect(container.querySelector('ellipse')).not.toBeNull();
  expect(screen.getAllByRole('button', { name: 'teamConnections.agentNodeLabel' })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button', { name: 'teamConnections.agentNodeLabel' })[0]);
  expect(onOpenProject).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^(a|b)$/) }));
});
it('keeps every accessible AI in the network instead of truncating the directory', async () => {
  const manyProjects = Array.from({ length: 14 }, (_, index) => ({ id: `agent-${index}`, name: `Agent ${index}`, archived: 0 })) as Project[];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => ({ ok: true, json: async () => String(url).includes('/users/') ? [{ id: 1, username: 'Alice' }] : [{ userId: 1, username: 'Alice', role: 'member' }] }) as Response);
  render(<TeamConnections projects={manyProjects} onOpenProject={vi.fn()} />);
  await screen.findByRole('img');
  expect(screen.getAllByRole('button', { name: 'teamConnections.agentNodeLabel' })).toHaveLength(14);
});

it('keeps unknown columns distinct from absent connections', async () => {
  mock(true); const { container } = render(<TeamConnections projects={projects} onOpenProject={vi.fn()} />);
  await screen.findByRole('img');
  expect(container.querySelectorAll('[data-connection]')).toHaveLength(1);
  expect(container.querySelector('svg')).toHaveTextContent('?');
  expect(screen.getByText('teamConnections.networkScope')).toBeInTheDocument();
  expect(screen.getByText('teamConnections.partial')).toBeInTheDocument();
});
it('refreshes read-only data and reports failures', async () => {
  const fetch = mock(); render(<TeamConnections projects={projects} onOpenProject={vi.fn()} />);
  await screen.findByRole('img'); fireEvent.click(screen.getByRole('button', { name: 'teamConnections.refresh' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
  fetch.mockResolvedValue({ ok: false } as Response);
  await screen.findByRole('img'); fireEvent.click(screen.getByRole('button', { name: 'teamConnections.refresh' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('teamConnections.error');
});
