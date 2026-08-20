import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@tower/shared';
import { useFileStore, type FileEntry } from '../../stores/file-store';
import { FileTree } from './FileTree';

/**
 * Owns: Files tab's note-only filter mode.
 * Public API: <NotesView projects onFileClick />.
 * Design: render notes through the same FileTree component and the same
 * expandedProjects / expandedPaths persistence as the ordinary Files tree.
 */

type NotesMode = 'current';

type NoteItem = {
  path: string;
  absolutePath: string;
  displayTitle: string;
  title: string;
  titleSource: 'frontmatter' | 'h1' | 'html' | 'filename';
  titleQuality: 'high' | 'medium' | 'low';
  kind: string;
  inferredType: string;
  pathClass: string;
  score: number;
  modified?: string;
  size?: number;
};

type NoteFolder = {
  folder: string;
  label: string;
  documentCount: number;
  score: number;
  highTitleCount: number;
  items: NoteItem[];
};

type NotesIndexResponse = {
  projectRoot: string;
  mode: NotesMode;
  summary: {
    totalItems: number;
    currentItems: number;
    archiveItems: number;
    systemItems: number;
    generatedItems: number;
    otherItems: number;
    currentFolders: number;
  };
  folders: NoteFolder[];
  hiddenBuckets: {
    archive: number;
    system: number;
    generated: number;
    other: number;
  };
};

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: NotesIndexResponse };

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function itemMatchesQuery(item: NoteItem, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  return [item.displayTitle, item.title, item.path, item.inferredType, item.kind]
    .some((value) => value.toLowerCase().includes(q));
}

function displayNameForNote(item: NoteItem): string {
  const idx = item.path.lastIndexOf('/');
  return idx === -1 ? item.path : item.path.slice(idx + 1);
}

function toAbsoluteFolder(rootPath: string, folder: string): string {
  if (!folder || folder === '.') return rootPath;
  return `${rootPath.replace(/\/+$/, '')}/${folder}`;
}

function applyExpandedState(entries: FileEntry[], expandedPaths: Set<string>, forceExpand: boolean): FileEntry[] {
  return entries.map((entry) => {
    if (!entry.isDirectory) return entry;
    const children = entry.children ? applyExpandedState(entry.children, expandedPaths, forceExpand) : entry.children;
    return {
      ...entry,
      isExpanded: forceExpand || expandedPaths.has(entry.path),
      children,
    };
  });
}

function buildNoteTree(data: NotesIndexResponse, expandedPaths: Set<string>, query: string): FileEntry[] {
  const rootPath = data.projectRoot.replace(/\/+$/, '');
  const q = normalizeQuery(query);
  const root: FileEntry[] = [];
  const dirByPath = new Map<string, FileEntry>();

  const ensureDir = (folder: string): FileEntry[] => {
    if (!folder || folder === '.') return root;
    let currentChildren = root;
    let currentRel = '';
    for (const part of folder.split('/').filter(Boolean)) {
      currentRel = currentRel ? `${currentRel}/${part}` : part;
      const absPath = toAbsoluteFolder(rootPath, currentRel);
      let dir = dirByPath.get(absPath);
      if (!dir) {
        dir = {
          name: part,
          path: absPath,
          isDirectory: true,
          children: [],
          isExpanded: false,
        };
        dirByPath.set(absPath, dir);
        currentChildren.push(dir);
      }
      currentChildren = dir.children || [];
    }
    return currentChildren;
  };

  for (const folder of data.folders) {
    const items = folder.items.filter((item) => itemMatchesQuery(item, q));
    if (items.length === 0) continue;
    const children = ensureDir(folder.folder);
    for (const item of items) {
      children.push({
        name: displayNameForNote(item),
        path: item.absolutePath,
        isDirectory: false,
        extension: item.path.split('.').pop(),
        size: item.size,
        modified: item.modified,
      });
    }
  }

  const sortEntries = (entries: FileEntry[]): FileEntry[] => entries
    .map((entry) => entry.isDirectory && entry.children
      ? { ...entry, children: sortEntries(entry.children) }
      : entry)
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

  return applyExpandedState(sortEntries(root), expandedPaths, q.length > 0);
}

function ProjectNotesSection({
  project,
  query,
  onFileClick,
}: {
  project: Project;
  query: string;
  onFileClick: (path: string) => void;
}) {
  const { t } = useTranslation('files');
  const expandedProjects = useFileStore((s) => s.expandedProjects);
  const toggleProjectExpanded = useFileStore((s) => s.toggleProjectExpanded);
  const expandedPaths = useFileStore((s) => s.expandedPaths);
  const addExpandedPath = useFileStore((s) => s.addExpandedPath);
  const removeExpandedPath = useFileStore((s) => s.removeExpandedPath);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const rootPath = project.rootPath || '';
  const hasQuery = normalizeQuery(query).length > 0;
  const isExpanded = expandedProjects.has(project.id);
  const effectiveExpanded = isExpanded || hasQuery;

  useEffect(() => {
    if (!effectiveExpanded || !rootPath) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    const params = new URLSearchParams({ path: rootPath, mode: 'current', maxFiles: '2500', maxDepth: '8' });
    fetch(`/api/files/notes-index?${params.toString()}`, {
      headers: getAuthHeaders(),
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body as NotesIndexResponse;
      })
      .then((data) => setState({ status: 'ready', data }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', error: err?.message || t('notesView.loadFailed') });
      });
    return () => controller.abort();
  }, [effectiveExpanded, rootPath, t]);

  const ready = state.status === 'ready' ? state.data : null;
  const entries = useMemo(() => {
    if (!ready) return [];
    return buildNoteTree(ready, expandedPaths, query);
  }, [expandedPaths, query, ready]);
  const visibleCount = useMemo(() => {
    if (!ready) return 0;
    const q = normalizeQuery(query);
    if (!q) return ready.summary.currentItems;
    return ready.folders.reduce((sum, folder) => sum + folder.items.filter((item) => itemMatchesQuery(item, q)).length, 0);
  }, [query, ready]);

  const handleToggleProject = () => {
    toggleProjectExpanded(project.id);
  };

  const handleDirectoryClick = (dirPath: string) => {
    if (hasQuery) return;
    if (expandedPaths.has(dirPath)) removeExpandedPath(dirPath);
    else addExpandedPath(dirPath);
  };

  return (
    <div className="mb-0">
      <div
        className="flex items-center gap-1.5 px-1 py-2 rounded-md cursor-pointer transition-colors group/proj hover:bg-surface-800/70"
        onClick={handleToggleProject}
      >
        <svg className={`w-3.5 h-3.5 text-surface-600 group-hover/proj:text-surface-300 transition-all shrink-0 ${!effectiveExpanded ? '-rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        <span className="text-[17px] leading-5 font-bold text-gray-300 truncate flex-1">{project.name}</span>
        {(state.status === 'loading' || ready) && (
          <span className="text-[12px] tabular-nums text-surface-600 shrink-0">
            {state.status === 'loading' ? 'scan…' : `${visibleCount}`}
          </span>
        )}
      </div>

      {effectiveExpanded && (
        <div className="ml-1.5 pl-2 border-l border-surface-700/25">
          {state.status === 'loading' && entries.length === 0 && (
            <p className="text-[14px] text-gray-500 py-2">{t('notesView.loading')}</p>
          )}
          {state.status === 'error' && (
            <p className="text-[14px] tone-danger tone-text py-2">{state.error}</p>
          )}
          {entries.length > 0 && (
            <FileTree
              entries={entries}
              onFileClick={onFileClick}
              onDirectoryClick={handleDirectoryClick}
            />
          )}
          {state.status === 'ready' && entries.length === 0 && (
            <p className="text-[14px] text-surface-600 py-2">{t('notesView.empty')}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function NotesView({
  projects,
  onFileClick,
}: {
  projects: Project[];
  onFileClick: (path: string) => void;
}) {
  const { t } = useTranslation('files');
  const [query, setQuery] = useState('');
  const visibleProjects = useMemo(() => projects.filter((p) => !!p.rootPath), [projects]);

  return (
    <div className="min-h-full px-2 pb-3">
      <div className="mb-1 flex items-center gap-1.5 rounded-lg border border-surface-800/70 bg-surface-950/35 px-2 py-1.5">
        <svg className="h-3.5 w-3.5 shrink-0 text-surface-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('notesView.searchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-200 placeholder:text-surface-700 outline-none"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} className="text-[12px] text-surface-600 hover:text-gray-300">{t('notesView.clear')}</button>
        )}
      </div>

      {visibleProjects.map((project) => (
        <ProjectNotesSection
          key={project.id}
          project={project}
          query={query}
          onFileClick={onFileClick}
        />
      ))}
    </div>
  );
}
