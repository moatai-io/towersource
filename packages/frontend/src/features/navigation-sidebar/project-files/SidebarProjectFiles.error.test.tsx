// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { SidebarProjectFiles } from './SidebarProjectFiles';
import { useFileStore } from '../../../stores/file-store';

vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key === 'retry' ? 'Retry' : key }) }));
vi.mock('../../../hooks/useDialog', () => ({ useConfirm: () => vi.fn() }));

beforeEach(() => {
  useFileStore.setState({
    expandedProjects: new Set(['operator-project']),
    projectTrees: {},
    projectLoaded: {},
    expandedPaths: new Set(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows file API failures instead of presenting them as an empty project', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Access denied: outside your project folders' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })));

  render(<SidebarProjectFiles project={{ id: 'operator-project', name: 'tower_project_dev', rootPath: '/workspace/projects/tower_project_dev' }} onFileClick={() => {}} />);

  expect((await screen.findByRole('alert')).textContent).toContain('Access denied: outside your project folders');
  expect(screen.queryByText('Empty')).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/files/tree?path='), expect.any(Object)));
});
