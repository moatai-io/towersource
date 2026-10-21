import { FileOperationFeedback } from '../../../features/file-operation-feedback/FileOperationFeedback';
import { uploadScope, reportUploadUnknown } from '../../../features/file-operation-feedback/feedback';
/**
 * Owns: Project file tree navigation inside the Sidebar.
 * Public API: SidebarProjectFiles. See ../README.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileTree } from '../../../components/files/FileTree';
import { useConfirm } from '../../../hooks/useDialog';
import { useFileStore, type FileEntry } from '../../../stores/file-store';
import { readDroppedItems, uploadDroppedFiles } from '../../../utils/folder-drop';
import { notifyUploadResult } from '../../../utils/upload-notice';
import { emitProductNotice } from '../../../utils/product-notice';
import { toastError, toastSuccess } from '../../../utils/toast';

// Stable empty selector result prevents Zustand subscribers from re-rendering forever.
const EMPTY_ENTRIES: FileEntry[] = [];

/* ── Project File Section — collapsible project header + lazy-loaded FileTree ── */

export function SidebarProjectFiles({ project, onFileClick, onPinFile, onNewSessionInFolder }: {
  project: { id: string; name: string; rootPath?: string | null; color?: string; [key: string]: any };
  onFileClick: (path: string) => void;
  onPinFile?: (path: string) => void;
  onNewSessionInFolder?: (path: string) => void;
}) {
  const { t } = useTranslation('layout');
  const confirm = useConfirm();
  // Persisted collapsed state via zustand store
  const isExpanded = useFileStore((s) => s.expandedProjects.has(project.id));
  const toggleProjectExpanded = useFileStore((s) => s.toggleProjectExpanded);
  const refreshTrigger = useFileStore((s) => s.refreshTrigger);
  const bumpRefreshTrigger = useFileStore((s) => s.bumpRefreshTrigger);
  const showHidden = useFileStore((s) => s.showHidden);

  // Tree state lives in the store (keyed by project.id) so it survives sidebar tab
  // switches and any other ProjectFileSection unmount/remount. Local useState would
  // reset on every remount, collapsing the user's open folders.
  const entries = useFileStore((s) => s.projectTrees[project.id] || EMPTY_ENTRIES);
  const setEntries = useCallback((next: FileEntry[] | ((prev: FileEntry[]) => FileEntry[])) => {
    if (typeof next === 'function') {
      useFileStore.getState().updateProjectTree(project.id, next);
    } else {
      useFileStore.getState().setProjectTree(project.id, next);
    }
  }, [project.id]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  // `loaded` is also in the store so the initial-load skip survives remounts
  const loaded = useRef(useFileStore.getState().projectLoaded[project.id] || false);
  const prevTrigger = useRef(refreshTrigger);
  const treeLoadGeneration = useRef(0);
  const refreshRetryTimer = useRef<number | null>(null);

  // Quick-action state for project header buttons
  const [headerAction, setHeaderAction] = useState<'file' | 'folder' | null>(null);
  const [projectActionMenuOpen, setProjectActionMenuOpen] = useState(false);
  const [headerInputValue, setHeaderInputValue] = useState('');
  const headerInputRef = useRef<HTMLInputElement>(null);
  const headerUploadRef = useRef<HTMLInputElement>(null);
  const [headerDragOver, setHeaderDragOver] = useState(false);
  const [headerDropType, setHeaderDropType] = useState<'move' | 'upload' | null>(null);

  const rootPath = project.rootPath;

  // Debug: log mount state
  useEffect(() => {
    console.log(`[ProjectFileSection] mount: id=${project.id}, name=${project.name}, isExpanded=${isExpanded}, rootPath=${rootPath}`);
  }, []);

  const fetchDir = useCallback(async (dirPath: string): Promise<FileEntry[]> => {
    const tk = localStorage.getItem('token');
    const hdrs: Record<string, string> = {};
    if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
    const url = `/api/files/tree?path=${encodeURIComponent(dirPath)}${showHidden ? '&showHidden=true' : ''}`;
    const res = await fetch(url, { headers: hdrs });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Could not load files (${res.status})`);
    }
    return Array.isArray(data.entries) ? data.entries : [];
  }, [showHidden]);

  /**
   * Recursively rehydrate the tree: for each directory path in the persisted
   * `expandedPaths` set, fetch its children and mark it as expanded. This is
   * what keeps the user's "open folders" visible after a refreshTrigger bump
   * (upload, file create/delete, file_changed WS event) — the alternative
   * (just calling fetchDir on the root) would silently collapse everything
   * under depth 1.
   *
   * Children are fetched in parallel within a directory; depth is sequential
   * (each level depends on the previous). Typical user has 2-3 levels open
   * with 1-3 expanded folders per level → small extra cost.
   */
  const fillExpanded = useCallback(async (
    items: FileEntry[],
    expandedPaths: Set<string>,
    fresh: boolean,
  ): Promise<FileEntry[]> => {
    return Promise.all(items.map(async (e) => {
      if (!e.isDirectory || !expandedPaths.has(e.path)) return e;
      // If we already have children loaded and this is not a forced refresh,
      // recurse into the existing children — preserves them across mounts
      // when nothing actually changed.
      const childSource = !fresh && e.children && !e.isLoading ? e.children : await fetchDir(e.path);
      const filledChildren = await fillExpanded(childSource, expandedPaths, fresh);
      return { ...e, isExpanded: true, children: filledChildren, isLoading: false };
    }));
  }, [fetchDir]);

  const loadTree = useCallback(async (force?: boolean) => {
    if (!rootPath || (loaded.current && !force)) return;
    const generation = ++treeLoadGeneration.current;
    setLoading(true);
    setLoadError('');
    try {
      const expandedPaths = useFileStore.getState().expandedPaths;
      const rootEntries = await fetchDir(rootPath);
      // Only the first load may show a root-only tree. During refresh, removing
      // descendants temporarily shrinks the scroll container and loses position.
      if (generation !== treeLoadGeneration.current) return;
      if (!loaded.current) setEntries(rootEntries);
      loaded.current = true;
      useFileStore.getState().markProjectLoaded(project.id, true);

      const filled = await fillExpanded(rootEntries, expandedPaths, !!force);
      // Uploads and file_changed events can schedule overlapping refreshes. Only
      // the newest result may replace the visible tree; otherwise a slower stale
      // request can make the folder the user is working in disappear again.
      if (generation !== treeLoadGeneration.current) return;
      setEntries(filled);
    } catch (error) {
      if (generation !== treeLoadGeneration.current) return;
      setLoadError(error instanceof Error ? error.message : 'Could not load files');
    } finally {
      if (generation === treeLoadGeneration.current) setLoading(false);
    }
  }, [rootPath, fetchDir, fillExpanded, setEntries, project.id]);

  // Auto-load on mount if project was previously expanded.
  //
  // Stale-while-revalidate: when the cache from a prior mount is already in
  // the store (loaded.current === true), still kick off a force refresh so
  // folders/files created while this section was unmounted (tab switched
  // away, sidebar collapsed, fresh page load with persisted cache) appear
  // without requiring a manual page reload.  Without this, b8fb594c's
  // store-backed cache would silently show stale entries forever.
  useEffect(() => {
    if (isExpanded) void loadTree(loaded.current);
  }, [isExpanded, loadTree]);

  const refreshTreeSoon = useCallback((retry = false) => {
    void loadTree(true);
    if (refreshRetryTimer.current !== null) {
      window.clearTimeout(refreshRetryTimer.current);
      refreshRetryTimer.current = null;
    }
    if (retry) {
      refreshRetryTimer.current = window.setTimeout(() => {
        refreshRetryTimer.current = null;
        void loadTree(true);
      }, 600);
    }
  }, [loadTree]);

  // A drop upload already tells us exactly which directory changed. Refresh only
  // that branch so the visible tree never gets replaced while the upload result
  // arrives. The file_changed event remains the fallback full reconciliation.
  const refreshUploadedDirectory = useCallback(async (targetDir?: string) => {
    if (!targetDir || targetDir === rootPath) {
      refreshTreeSoon();
      return;
    }
    const generation = treeLoadGeneration.current;
    const children = await fillExpanded(
      await fetchDir(targetDir), useFileStore.getState().expandedPaths, true,
    );
    if (generation !== treeLoadGeneration.current) return;
    const replaceChildren = (items: FileEntry[]): FileEntry[] => items.map((entry) => {
      if (entry.path === targetDir) {
        return { ...entry, children, isLoading: false };
      }
      return entry.children
        ? { ...entry, children: replaceChildren(entry.children) }
        : entry;
    });
    setEntries((current) => replaceChildren(current));
  }, [fetchDir, fillExpanded, refreshTreeSoon, rootPath, setEntries]);

  useEffect(() => () => {
    treeLoadGeneration.current += 1;
    if (refreshRetryTimer.current !== null) {
      window.clearTimeout(refreshRetryTimer.current);
    }
  }, []);

  // Auto-refresh when refreshTrigger changes (new files created/deleted).
  // Be aggressive here: file_changed can arrive from AI/tool writes, not just
  // explicit file-tab actions. If the project is expanded, refresh even when
  // its first load is still in progress/not marked loaded yet; otherwise visible
  // trees can stay stale until a manual refresh.
  useEffect(() => {
    if (refreshTrigger !== prevTrigger.current) {
      prevTrigger.current = refreshTrigger;
      if (isExpanded && rootPath) {
        const timer = window.setTimeout(() => {
          refreshTreeSoon(true);
        }, 75);
        return () => window.clearTimeout(timer);
      }
    }
  }, [refreshTrigger, isExpanded, rootPath, refreshTreeSoon]);

  // Toggle or expand a directory within the local tree
  const handleDirectoryClick = useCallback(async (dirPath: string) => {
    // Capture pre-toggle state so we know whether to fetch (collapse → no fetch)
    // and whether to add or remove from the persisted expandedPaths set.
    const findEntry = (items: FileEntry[]): FileEntry | null => {
      for (const e of items) {
        if (e.path === dirPath) return e;
        if (e.children) { const found = findEntry(e.children); if (found) return found; }
      }
      return null;
    };
    const wasExpanded = !!findEntry(entries)?.isExpanded;

    // Sync the persisted expandedPaths set so the state survives any future
    // remount/refresh, even if the in-store tree cache gets cleared.
    if (wasExpanded) {
      useFileStore.getState().removeExpandedPath(dirPath);
    } else {
      useFileStore.getState().addExpandedPath(dirPath);
    }

    const findAndToggle = (items: FileEntry[]): FileEntry[] =>
      items.map(e => {
        if (e.path === dirPath) {
          if (e.isExpanded) {
            // Collapse
            return { ...e, isExpanded: false };
          }
          // Expand — will load children
          return { ...e, isExpanded: true, isLoading: true };
        }
        if (e.children) return { ...e, children: findAndToggle(e.children) };
        return e;
      });

    setEntries(prev => findAndToggle(prev));

    if (wasExpanded) {
      // Was already expanded → we just collapsed, no fetch needed
      return;
    }

    // Fetch children
    const children = await fetchDir(dirPath);
    const setChildren = (items: FileEntry[]): FileEntry[] =>
      items.map(e => {
        if (e.path === dirPath) return { ...e, children, isExpanded: true, isLoading: false };
        if (e.children) return { ...e, children: setChildren(e.children) };
        return e;
      });
    setEntries(prev => setChildren(prev));
  }, [entries, fetchDir, setEntries]);

  const handleToggle = () => {
    toggleProjectExpanded(project.id);
    if (!isExpanded) loadTree(); // expanding → load
  };

  // Header quick-action: create file/folder at project root
  const handleHeaderNewSubmit = async () => {
    const name = headerInputValue.trim();
    if (!name || !rootPath) { setHeaderAction(null); return; }
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const fullPath = `${rootPath}/${name}`;
      const endpoint = headerAction === 'folder' ? '/api/files/mkdir' : '/api/files/create';
      const body = headerAction === 'folder' ? { path: fullPath } : { path: fullPath, content: '' };
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      toastSuccess(`${name} created`);
      bumpRefreshTrigger();
      // Ensure project is expanded to show new item
      if (!isExpanded) toggleProjectExpanded(project.id);
      refreshTreeSoon(true);
    } catch (err: any) {
      emitProductNotice({ code: 'sidebar.file.create.failed', technicalDetail: err });
    }
    setHeaderAction(null);
    setHeaderInputValue('');
  };

  // Header upload via file input (flat — input element doesn't expose folder structure)
  const handleHeaderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !rootPath) return;
    const items = Array.from(files).map((f) => ({ file: f, relativePath: f.name }));
    try {
      const result = await uploadDroppedFiles(rootPath, items);
      notifyUploadResult(result, project.name, uploadScope('project', String(project.id)));
      bumpRefreshTrigger();
      if (!isExpanded) toggleProjectExpanded(project.id);
      refreshTreeSoon(true);
    } catch (err) {
      reportUploadUnknown(uploadScope('project', String(project.id)));
    }
    e.target.value = '';
  };

  // Header drag-and-drop upload
  const handleHeaderDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHeaderDragOver(false);
    setHeaderDropType(null);

    // 1) Internal item move (file/folder → project root)
    const moveData = e.dataTransfer.getData('application/x-filetree-move');
    if (moveData && rootPath) {
      try {
        const parsed = JSON.parse(moveData);
        const srcPath: string = parsed.path;
        const srcName: string = parsed.name;
        const destPath = `${rootPath}/${srcName}`;

        // Already at root
        if (srcPath === destPath) return;
        // Prevent circular move
        if (rootPath.startsWith(srcPath + '/')) {
          toastError('Cannot move a folder into its own subfolder');
          return;
        }

        const ok = await confirm({
          title: t('moveToRoot'),
          message: t('confirmMoveItemToRoot', { item: srcName, project: project.name }),
          confirmLabel: t('move'),
        });
        if (!ok) return;

        const token = localStorage.getItem('token');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch('/api/files/rename', {
          method: 'POST', headers,
          body: JSON.stringify({ oldPath: srcPath, newPath: destPath }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Move failed');
        toastSuccess(`Moved "${srcName}" to ${project.name}/`);
        bumpRefreshTrigger();
        if (!isExpanded) toggleProjectExpanded(project.id);
        refreshTreeSoon(true);
      } catch (err: any) {
        emitProductNotice({ code: 'sidebar.file.move.failed', technicalDetail: err });
      }
      return;
    }

    // 2) External file/folder upload
    if (e.dataTransfer.getData('application/x-attachment')) return;
    if (!rootPath) return;

    let items;
    try {
      items = await readDroppedItems(e.dataTransfer);
    } catch (err) {
      console.error('[ProjectFileSection] Failed to read dropped items:', err);
      toastError('Failed to read dropped folder');
      return;
    }
    if (items.length === 0) return;

    try {
      const result = await uploadDroppedFiles(rootPath, items);
      notifyUploadResult(result, project.name, uploadScope('project', String(project.id)));
      bumpRefreshTrigger();
      if (!isExpanded) toggleProjectExpanded(project.id);
      refreshTreeSoon(true);
    } catch (err) {
      reportUploadUnknown(uploadScope('project', String(project.id)));
    }
  };

  // Auto-focus header input
  useEffect(() => {
    if (headerAction) headerInputRef.current?.focus();
  }, [headerAction]);

  if (!rootPath) return null;

  const headerActionBtnClass = 'inline-flex h-6 w-6 items-center justify-center rounded p-0.5 text-surface-500 transition-colors hover:text-primary-400 hover:bg-surface-700/50 shrink-0';

  return (
    <div className="mb-0 min-w-0">
      <div
        className={`flex min-w-0 items-center gap-1.5 px-1 py-2 rounded-md cursor-pointer transition-colors group/proj hover:bg-surface-800/70 ${
          headerDragOver
            ? headerDropType === 'move'
              ? 'bg-blue-900/30 ring-1 ring-blue-500/40'
              : 'bg-primary-900/20 ring-1 ring-primary-500/40'
            : ''
        }`}
        onClick={handleToggle}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDragEnter={(e) => {
          e.preventDefault(); e.stopPropagation();
          const isMove = e.dataTransfer.types.includes('application/x-filetree-move');
          setHeaderDropType(isMove ? 'move' : 'upload');
          setHeaderDragOver(true);
        }}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) { setHeaderDragOver(false); setHeaderDropType(null); } }}
        onDrop={handleHeaderDrop}
      >
        <svg className={`w-3.5 h-3.5 text-surface-600 group-hover/proj:text-surface-300 transition-all shrink-0 ${!isExpanded ? '-rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        <span className="min-w-0 flex-1 truncate text-[17px] leading-5 font-bold text-gray-300" title={project.name}>{project.name}</span>

        <div className="relative shrink-0">
          <button
            type="button"
            className={headerActionBtnClass}
            title={t('fileActions')}
            aria-label={t('fileActions')}
            onClick={(e) => {
              e.stopPropagation();
              setProjectActionMenuOpen((current) => !current);
            }}
          >
            <span aria-hidden="true" className="text-base leading-none">⋯</span>
          </button>
          {projectActionMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-44 rounded-lg border border-surface-700 bg-surface-800 py-1 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="w-full px-3 py-1.5 text-left text-[13px] text-surface-300 hover:bg-surface-700" onClick={() => { setProjectActionMenuOpen(false); setHeaderAction('file'); setHeaderInputValue(''); if (!isExpanded) { toggleProjectExpanded(project.id); loadTree(); } }}>{t('newFile')}</button>
              <button type="button" className="w-full px-3 py-1.5 text-left text-[13px] text-surface-300 hover:bg-surface-700" onClick={() => { setProjectActionMenuOpen(false); setHeaderAction('folder'); setHeaderInputValue(''); if (!isExpanded) { toggleProjectExpanded(project.id); loadTree(); } }}>{t('newFolder')}</button>
              <button type="button" className="w-full px-3 py-1.5 text-left text-[13px] text-surface-300 hover:bg-surface-700" onClick={() => { setProjectActionMenuOpen(false); headerUploadRef.current?.click(); }}>{t('uploadToProject')}</button>
              <button type="button" className="w-full px-3 py-1.5 text-left text-[13px] text-surface-300 hover:bg-surface-700" onClick={() => {
                setProjectActionMenuOpen(false);
                const token = localStorage.getItem('token');
                const url = `/api/files/download-zip?path=${encodeURIComponent(rootPath)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
                window.open(url, '_blank');
              }}>{t('downloadProjectZip')}</button>
            </div>
          )}
        </div>
        <input ref={headerUploadRef} type="file" multiple hidden onChange={handleHeaderUpload} />
      </div>

      <FileOperationFeedback scope={uploadScope('project', String(project.id))} />
      {/* Inline input for header new file/folder action */}
      {headerAction && (
        <div className="flex items-center gap-1.5 px-2 py-1 ml-5 bg-surface-850 rounded-md mt-0.5">
          {headerAction === 'folder' ? (
            <svg className="w-3.5 h-3.5 text-yellow-400/70 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 text-primary-400/70 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          )}
          <input
            ref={headerInputRef}
            type="text"
            value={headerInputValue}
            onChange={(e) => setHeaderInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleHeaderNewSubmit();
              if (e.key === 'Escape') setHeaderAction(null);
            }}
            onBlur={() => setHeaderAction(null)}
            placeholder={headerAction === 'folder' ? t('folderNameShort') : t('fileNameShort')}
            className="flex-1 bg-transparent border border-primary-500/50 rounded px-2 py-0.5 text-[14px] text-gray-200 outline-none placeholder-gray-600"
          />
        </div>
      )}

      {isExpanded && (
        <div className="ml-1.5 pl-2 border-l border-surface-700/25">
          {loading && entries.length === 0 && (
            <p className="text-[14px] text-gray-500 py-2">Loading...</p>
          )}
          {loadError && (
            <div className="py-2 pr-2 text-[12px] text-red-300" role="alert">
              <p>{loadError}</p>
              <button type="button" onClick={() => { void loadTree(true); }} className="mt-1 font-semibold text-surface-200 hover:text-surface-50">{t('retry')}</button>
            </div>
          )}
          {!loadError && entries.length > 0 && (
            <FileTree
              entries={entries}
              onFileClick={onFileClick}
              onDirectoryClick={handleDirectoryClick}
              onPinFile={onPinFile}
              onNewSessionInFolder={onNewSessionInFolder}
              onRefreshTree={refreshUploadedDirectory}
            />
          )}
          {!loading && !loadError && loaded.current && entries.length === 0 && (
            <p className="text-[14px] text-surface-600 py-2">Empty</p>
          )}
        </div>
      )}
    </div>
  );
}
