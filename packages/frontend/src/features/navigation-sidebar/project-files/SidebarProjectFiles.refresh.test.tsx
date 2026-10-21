// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFileStore } from '../../../stores/file-store';
import { SidebarProjectFiles } from './SidebarProjectFiles';

vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/useDialog', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../../components/files/FileTree', () => ({ FileTree: ({ entries }: any) => <pre data-testid="tree">{JSON.stringify(entries)}</pre> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps expanded descendants visible while a refresh waits for child directories', async () => {
  const leaf = { name: 'keep.txt', path: '/project/folder/keep.txt', isDirectory: false };
  const folder = { name: 'folder', path: '/project/folder', isDirectory: true };
  const existing = [{ ...folder, isExpanded: true, children: [leaf] }];
  useFileStore.setState({
    expandedProjects: new Set(['refresh-test']), expandedPaths: new Set([folder.path]),
    projectTrees: { 'refresh-test': existing }, projectLoaded: { 'refresh-test': true },
  });
  let resolveChildren!: (value: unknown) => void;
  const children = new Promise(resolve => { resolveChildren = resolve; });
  const fetchMock = vi.fn((url: string) => url.includes(encodeURIComponent(folder.path))
    ? children : Promise.resolve({ ok: true, json: async () => ({ entries: [folder] }) }));
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<SidebarProjectFiles project={{ id: 'refresh-test', name: 'Project', rootPath: '/project' }} onFileClick={() => {}} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(view.getByTestId('tree').textContent).toContain('keep.txt');
  expect(useFileStore.getState().projectTrees['refresh-test']).toEqual(existing);
  await act(async () => { resolveChildren({ ok: true, json: async () => ({ entries: [leaf, { ...leaf, name: 'new.txt', path: '/project/folder/new.txt' }] }) }); });
  await waitFor(() => expect(view.getByTestId('tree').textContent).toContain('new.txt'));
  expect(view.getByTestId('tree').textContent).toContain('keep.txt');
});
