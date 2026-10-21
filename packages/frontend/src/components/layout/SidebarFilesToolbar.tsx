import { uploadDroppedFiles } from '../../utils/folder-drop';
import { reportUploadUnknown } from '../../features/file-operation-feedback/feedback';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileEntry } from '../../stores/file-store';
import { useFileStore } from '../../stores/file-store';
import { toastSuccess } from '../../utils/toast';
import { notifyUploadResult } from '../../utils/upload-notice';
import { emitProductNotice } from '../../utils/product-notice';

/** Compact toolbar shown at top of Files tab — New, Upload, show hidden, refresh */
/** Toggle button for multi-select mode */
function SelectModeToggle() {
  const selectMode = useFileStore((s) => s.selectMode);
  const toggleSelectMode = useFileStore((s) => s.toggleSelectMode);
  return (
    <button
      onClick={() => toggleSelectMode()}
      className={`p-1 rounded transition-colors ${
        selectMode
          ? 'text-primary-400 bg-primary-600/20'
          : 'text-surface-600 hover:text-primary-400 hover:bg-surface-800'
      }`}
      title={selectMode ? 'Exit select mode' : 'Select files (Ctrl+Click)'}
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    </button>
  );
}

function SortMenuItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-[14px] transition-colors ${
        active ? 'text-primary-300 bg-primary-500/10' : 'text-gray-400 hover:text-gray-200 hover:bg-surface-700/70'
      }`}
    >
      <span className={`w-3.5 text-[12px] ${active ? 'text-primary-300' : 'text-transparent'}`}>✓</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

export function SidebarFileSearchResults({ rootPath, query, results, loading, error, onFileClick, onClear }: {
  rootPath: string;
  query: string;
  results: FileEntry[] | null;
  loading: boolean;
  error: string;
  onFileClick: (path: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation('layout');
  if (loading && results === null) return <div className="px-3 py-6 text-center text-[12px] text-surface-500">{t('searchingFiles')}</div>;
  if (error) return <div className="mx-2 mt-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-3 text-[12px] text-red-300">{error}</div>;
  if (!results?.length) return <div className="px-3 py-8 text-center"><p className="text-[13px] font-semibold text-surface-400">{t('noFileSearchResults')}</p><p className="mt-1 text-[11px] text-surface-600">“{query}”</p><button type="button" onClick={onClear} className="mt-3 text-[12px] font-semibold text-primary-300 hover:text-primary-200">{t('clearFileSearch')}</button></div>;
  return <div className="py-1">
    <div className="sticky top-0 z-10 flex items-center justify-between bg-surface-900/95 px-3 py-1.5 text-[11px] text-surface-600 backdrop-blur"><span>{t('fileSearchResults', { count: results.length })}</span>{loading && <span>{t('searchingFiles')}</span>}</div>
    {results.map((entry) => {
      const relativePath = entry.path.startsWith(rootPath) ? entry.path.slice(rootPath.length).replace(/^\/+/, '') : entry.path;
      const parentPath = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '.';
      return <button key={entry.path} type="button" onClick={() => entry.isDirectory ? onClear() : onFileClick(entry.path)} className="group flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-800/80" title={entry.path}>
        <span className={`mt-0.5 shrink-0 text-[13px] ${entry.isDirectory ? 'text-yellow-400/80' : 'text-primary-300/80'}`} aria-hidden="true">{entry.isDirectory ? '▸' : '▤'}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-surface-300 group-hover:text-surface-100">{entry.name}</span><span className="mt-0.5 block truncate text-[10px] text-surface-600">{parentPath}</span></span>
      </button>;
    })}
  </div>;
}

export function FilesToolbar({
  onRefresh,
  project,
  query,
  onQueryChange,
}: {
  onRefresh: (path?: string) => void;
  project: { id: string; name: string; rootPath?: string | null; color?: string };
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const { t } = useTranslation('layout');
  const showHidden = useFileStore((s) => s.showHidden);
  const toggleShowHidden = useFileStore((s) => s.toggleShowHidden);
  const bumpRefreshTrigger = useFileStore((s) => s.bumpRefreshTrigger);
  const fileSortMode = useFileStore((s) => s.fileSortMode);
  const setFileSortMode = useFileStore((s) => s.setFileSortMode);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [createKind, setCreateKind] = useState<'file' | 'folder' | null>(null);
  const [createName, setCreateName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!addMenuOpen && !viewMenuOpen) return;
    const handler = (event: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) setAddMenuOpen(false);
      if (viewMenuRef.current && !viewMenuRef.current.contains(event.target as Node)) setViewMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [addMenuOpen, viewMenuOpen]);

  useEffect(() => {
    if (createKind) window.setTimeout(() => createInputRef.current?.focus(), 0);
  }, [createKind]);

  const submitCreate = async () => {
    const name = createName.trim();
    if (!name || !project.rootPath || !createKind) return;
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const path = `${project.rootPath}/${name}`;
      const endpoint = createKind === 'folder' ? '/api/files/mkdir' : '/api/files/create';
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(createKind === 'file' ? { path, content: '' } : { path }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('fileCreateFailed'));
      toastSuccess(createKind === 'file' ? t('fileCreated', { name }) : t('folderCreated', { name }));
      setCreateKind(null);
      setCreateName('');
      setAddMenuOpen(false);
      bumpRefreshTrigger();
      onRefresh(project.rootPath || undefined);
    } catch (error) {
      emitProductNotice({ code: 'sidebar.file.create.failed', technicalDetail: error });
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length || !project.rootPath) return;
    try {
      const result = await uploadDroppedFiles(project.rootPath, Array.from(files).map(file => ({ file, relativePath: file.name })));
      notifyUploadResult(result, `${project.name}/`);
      bumpRefreshTrigger();
      onRefresh(project.rootPath || undefined);
    } catch (error) {
      reportUploadUnknown('upload:sidebar');
    } finally {
      event.target.value = '';
      setAddMenuOpen(false);
    }
  };

  const handleToggleHidden = () => {
    toggleShowHidden();
    setViewMenuOpen(false);
    window.setTimeout(() => onRefresh(project.rootPath || undefined), 50);
  };

  return (
    <div data-sidebar-file-toolbar="true" className="relative flex items-center gap-1.5 px-1 py-1.5">
      <label className="relative min-w-0 flex-1">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-600" aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') onQueryChange(''); }}
          placeholder={t('searchAgentFiles')}
          aria-label={t('searchAgentFiles')}
          className="h-8 w-full rounded-lg border border-surface-800 bg-surface-950 pl-8 pr-7 text-[12px] text-surface-200 outline-none placeholder:text-surface-650 focus:border-primary-500/60"
        />
        {query && <button type="button" onClick={() => onQueryChange('')} className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-surface-600 hover:bg-surface-800 hover:text-surface-200" aria-label={t('clearFileSearch')}>×</button>}
      </label>

      <SelectModeToggle />

      <div ref={addMenuRef} className="relative shrink-0">
        <button type="button" onClick={() => { setAddMenuOpen((open) => !open); setViewMenuOpen(false); }} className="grid h-8 w-8 place-items-center rounded-lg border border-surface-800 bg-surface-950 text-lg leading-none text-surface-400 hover:border-surface-700 hover:text-primary-300" title={t('addFileOrFolder')} aria-label={t('addFileOrFolder')}>+</button>
        {addMenuOpen && <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-surface-700 bg-surface-850 py-1 shadow-xl">
          {createKind ? <div className="px-2 py-1.5">
            <div className="mb-1 text-[11px] font-semibold text-surface-500">{createKind === 'file' ? t('newFile') : t('newFolder')}</div>
            <input ref={createInputRef} value={createName} onChange={(event) => setCreateName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submitCreate(); if (event.key === 'Escape') { setCreateKind(null); setCreateName(''); } }} placeholder={createKind === 'file' ? t('enterFileName') : t('folderNameShort')} className="h-8 w-full rounded-md border border-surface-700 bg-surface-950 px-2 text-[12px] text-surface-200 outline-none focus:border-primary-500/60" />
          </div> : <>
            <button type="button" onClick={() => setCreateKind('file')} className="w-full px-3 py-2 text-left text-[13px] text-surface-300 hover:bg-surface-700">{t('newFile')}</button>
            <button type="button" onClick={() => setCreateKind('folder')} className="w-full px-3 py-2 text-left text-[13px] text-surface-300 hover:bg-surface-700">{t('newFolder')}</button>
            <button type="button" onClick={() => fileInputRef.current?.click()} className="w-full px-3 py-2 text-left text-[13px] text-surface-300 hover:bg-surface-700">{t('chooseFilesFromComputer')}</button>
          </>}
        </div>}
        <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileUpload} />
      </div>

      <div ref={viewMenuRef} className="relative shrink-0">
        <button type="button" onClick={() => { setViewMenuOpen((open) => !open); setAddMenuOpen(false); }} className="grid h-8 w-8 place-items-center rounded-lg border border-surface-800 bg-surface-950 text-base leading-none text-surface-400 hover:border-surface-700 hover:text-primary-300" title={t('fileViewOptions')} aria-label={t('fileViewOptions')}>⋯</button>
        {viewMenuOpen && <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-lg border border-surface-700 bg-surface-850 py-1 shadow-xl">
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-surface-600">{t('fileSort')}</div>
          <SortMenuItem active={fileSortMode === 'folders-name'} onClick={() => { setFileSortMode('folders-name'); setViewMenuOpen(false); }}>{t('foldersThenName')}</SortMenuItem>
          <SortMenuItem active={fileSortMode === 'modified'} onClick={() => { setFileSortMode('modified'); setViewMenuOpen(false); }}>{t('recentlyModified')}</SortMenuItem>
          <SortMenuItem active={fileSortMode === 'name'} onClick={() => { setFileSortMode('name'); setViewMenuOpen(false); }}>{t('nameAz')}</SortMenuItem>
          <SortMenuItem active={fileSortMode === 'type'} onClick={() => { setFileSortMode('type'); setViewMenuOpen(false); }}>{t('byType')}</SortMenuItem>
          <div className="my-1 border-t border-surface-700/70" />
          <button type="button" onClick={handleToggleHidden} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-surface-300 hover:bg-surface-700"><span className="w-3.5 text-center text-primary-300">{showHidden ? '✓' : ''}</span>{t('showDotfiles')}</button>
          <button type="button" onClick={() => { onRefresh(project.rootPath || undefined); setViewMenuOpen(false); }} className="w-full px-3 py-2 text-left text-[13px] text-surface-300 hover:bg-surface-700">{t('refreshAll')}</button>
        </div>}
      </div>
    </div>
  );
}
