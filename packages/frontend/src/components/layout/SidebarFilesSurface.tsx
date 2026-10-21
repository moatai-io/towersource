import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FileEntry } from '../../stores/file-store';
import type { Project } from '../../stores/project-store';
import { useFileStore } from '../../stores/file-store';
import { useSettingsStore } from '../../stores/settings-store';
import { rememberAgentWorkspaceLocation } from '../../features/agent-workspace/navigation-state';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';
import { SessionFilesMenuSection } from './SessionFilesMenuSection';

const LazyPinList = React.lazy(() => import('../pinboard/PinList').then((module) => ({ default: module.PinList })));
const LazyFilesToolbar = React.lazy(() => import('./SidebarFilesToolbar').then((module) => ({ default: module.FilesToolbar })));
const LazySidebarFileSearchResults = React.lazy(() => import('./SidebarFilesToolbar').then((module) => ({ default: module.SidebarFileSearchResults })));
const LazySidebarProjectFiles = React.lazy(() => import('../../features/navigation-sidebar/project-files/SidebarProjectFiles').then((module) => ({ default: module.SidebarProjectFiles })));

function DeferredSidebarSurface({ children }: { children: React.ReactNode }) {
  return <React.Suspense fallback={null}>{children}</React.Suspense>;
}

function SidebarProjectFiles(props: React.ComponentProps<typeof LazySidebarProjectFiles>) {
  return <React.Suspense fallback={null}><LazySidebarProjectFiles {...props} /></React.Suspense>;
}

type MobileDocumentRecent = { path: string; name: string };

export interface SidebarFilesSurfaceProps {
  isMobile: boolean;
  activeSessionId: string | null;
  activeFileProject: Project | null;
  folderProjects: Project[];
  projectsSortedForFiles: Project[];
  folderProjectQuery: string;
  setFolderProjectQuery: (value: string) => void;
  mobileProjectPickerOpen: boolean;
  setMobileProjectPickerOpen: (value: boolean) => void;
  mobileProjectQuery: string;
  setMobileProjectQuery: (value: string) => void;
  mobileQuickFilesView: 'recent' | 'session' | null;
  setMobileQuickFilesView: (value: 'recent' | 'session' | null) => void;
  mobileDocumentRecents: MobileDocumentRecent[];
  fileSearchQuery: string;
  setFileSearchQuery: (value: string) => void;
  fileSearchResults: FileEntry[] | null;
  fileSearchLoading: boolean;
  fileSearchError: string;
  onRequestFileTree: () => void;
  onFileClick: (path: string) => void;
  onPinClick?: (pin: any) => void;
  onUnpinFile?: (id: number) => void;
  onPinFile?: (path: string) => void;
  onNewSessionInFolder?: (path: string) => void;
}

export function SidebarFilesSurface(props: SidebarFilesSurfaceProps) {
  const { t } = useTranslation('layout');
  const {
    isMobile, activeSessionId, activeFileProject, folderProjects, projectsSortedForFiles,
    folderProjectQuery, setFolderProjectQuery, mobileProjectPickerOpen, setMobileProjectPickerOpen,
    mobileProjectQuery, setMobileProjectQuery, mobileQuickFilesView, setMobileQuickFilesView,
    mobileDocumentRecents, fileSearchQuery, setFileSearchQuery,
    fileSearchResults, fileSearchLoading, fileSearchError, onRequestFileTree, onFileClick,
    onPinClick, onUnpinFile, onPinFile, onNewSessionInFolder,
  } = props;
  return (
<div data-sidebar-files-root="true" className={`h-full min-h-0 overflow-hidden ${isMobile ? 'flex flex-col' : 'grid grid-cols-[176px_minmax(0,1fr)]'}`}>
  {!isMobile && (
    <nav className="tower-sidebar-primary flex min-h-0 flex-col border-r border-surface-800/80 bg-surface-900/95 px-2 py-2" aria-label={t('selectProjectFolder')}>
      <div className="relative mb-2 shrink-0">
        <svg className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35m2.1-5.4a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg>
        <input value={folderProjectQuery} onChange={(event) => setFolderProjectQuery(event.target.value)} placeholder={t('searchProjects')} className="h-8 w-full rounded-lg border border-surface-800 bg-surface-950 pl-8 pr-2 text-[12px] text-surface-200 outline-none placeholder:text-surface-650 focus:border-primary-500/60" aria-label={t('searchFolderProjects')} />
      </div>
      <div className="scrollbar-none min-h-0 flex-1 space-y-1 overflow-y-auto">
        {folderProjects.map((project) => {
          const selected = activeFileProject?.id === project.id;
          return <button key={project.id} type="button" onClick={() => {
            rememberAgentWorkspaceLocation(project.id, 'files');
            useSettingsStore.getState().setCapabilityProjectId(project.id);
            useFileStore.getState().clearSelection();
          }} className={`relative flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-left transition-colors ${selected ? 'bg-primary-500/12 text-primary-700 ring-1 ring-primary-500/35 dark:text-primary-200' : 'text-surface-400 hover:bg-surface-800/80 hover:text-surface-200'}`} aria-pressed={selected} title={project.agent?.displayName || project.name}>
            {selected && <span className="absolute -left-2 h-5 w-0.5 rounded-r bg-primary-500" aria-hidden="true" />}
            <AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-7 w-7 shrink-0 rounded-lg" fallbackClassName="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-800 text-[11px]" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{project.agent?.displayName || project.name}</span>
          </button>;
        })}
        {folderProjects.length === 0 && <p className="px-2 py-4 text-[12px] text-surface-600">{t('noMatchingProjects')}</p>}
      </div>
    </nav>
  )}
  <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
  {isMobile && mobileProjectPickerOpen && (
    <section className="min-h-full px-3 py-3">
      <button type="button" onClick={() => { setMobileProjectPickerOpen(false); setMobileProjectQuery(''); }} className="mb-2 flex min-h-9 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-surface-300 active:bg-surface-800"><span aria-hidden="true">‹</span><span>{t('files')}</span></button>
      <h2 className="px-1 text-base font-bold text-surface-100">{t('selectProject')}</h2>
      <div className="relative mt-3">
        <svg className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m21 21-4.35-4.35m2.1-5.4a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg>
        <input value={mobileProjectQuery} onChange={(event) => setMobileProjectQuery(event.target.value)} placeholder={t('searchProjects')} className="h-10 w-full rounded-xl border border-surface-800 bg-surface-950 pl-10 pr-3 text-sm text-surface-200 outline-none placeholder:text-surface-650 focus:border-primary-500/60" aria-label={t('searchFileProjects')} />
      </div>
      <div className="mt-2 divide-y divide-surface-800/80">
        {projectsSortedForFiles.filter((project) => project.rootPath && !project.archived && `${project.agent?.displayName || ''} ${project.name}`.toLowerCase().includes(mobileProjectQuery.trim().toLowerCase())).map((project) => {
          const selected = project.id === activeFileProject?.id;
          return <button key={project.id} type="button" onClick={() => {
            rememberAgentWorkspaceLocation(project.id, 'files');
            useSettingsStore.getState().setCapabilityProjectId(project.id);
            useFileStore.getState().clearSelection();
            setMobileProjectPickerOpen(false);
            setMobileProjectQuery('');
          }} className={`flex min-h-12 w-full items-center gap-3 px-1 text-left ${selected ? 'font-bold text-primary-200' : 'text-surface-300 active:bg-surface-800'}`}>
            <AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-8 w-8 shrink-0 rounded-lg" fallbackClassName="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-800 text-[11px]" />
            <span className="min-w-0 flex-1 truncate text-sm">{project.agent?.displayName || project.name}</span>
            {selected && <span className="shrink-0 text-primary-300" aria-hidden="true">✓</span>}
          </button>;
        })}
      </div>
    </section>
  )}
  {isMobile && !mobileProjectPickerOpen && mobileQuickFilesView === null && (
    <section className="border-b border-surface-800 px-3 py-3">
      <div className="mb-2 px-0.5 text-[11px] font-bold uppercase tracking-[0.12em] text-surface-600">{t('quickFiles')}</div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setMobileQuickFilesView('session')} className="flex min-h-12 items-center gap-2 rounded-xl border border-surface-800 bg-surface-900 px-3 text-left active:bg-surface-800"><span className="min-w-0 flex-1 text-[12px] font-semibold text-surface-200">{t('thisConversationFiles')}</span><span className="text-surface-600">›</span></button>
        <button type="button" onClick={() => setMobileQuickFilesView('recent')} disabled={mobileDocumentRecents.length === 0} className="flex min-h-12 items-center gap-2 rounded-xl border border-surface-800 bg-surface-900 px-3 text-left active:bg-surface-800 disabled:opacity-45"><span className="min-w-0 flex-1 text-[12px] font-semibold text-surface-200">{t('recentDocuments')}</span><span className="text-xs tabular-nums text-surface-600">{mobileDocumentRecents.length} ›</span></button>
      </div>
    </section>
  )}
  {isMobile && !mobileProjectPickerOpen && mobileQuickFilesView === 'recent' && (
    <section className="min-h-full px-3 py-3">
      <button type="button" onClick={() => setMobileQuickFilesView(null)} className="mb-2 flex min-h-9 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-surface-300 active:bg-surface-800"><span aria-hidden="true">‹</span><span>{t('files')}</span></button>
      <h2 className="px-1 text-base font-bold text-surface-100">{t('recentDocuments')}</h2>
      <div className="mt-2 divide-y divide-surface-800/80">{mobileDocumentRecents.map((document) => <button key={document.path} type="button" onClick={() => onFileClick(document.path)} className="flex w-full items-center gap-2 px-1 py-3 text-left active:bg-surface-800" title={document.path}><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-500/10 text-sm text-primary-300" aria-hidden="true">📄</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-surface-200">{document.name}</span><span className="block truncate text-[10px] text-surface-600">{document.path}</span></span></button>)}</div>
    </section>
  )}
  {isMobile && !mobileProjectPickerOpen && mobileQuickFilesView === 'session' && <SessionFilesMenuSection activeSessionId={activeSessionId} placement="inline" isMobile onInlineBack={() => setMobileQuickFilesView(null)} onFileClick={onFileClick} />}
  {isMobile && !mobileProjectPickerOpen && mobileQuickFilesView === null && (
    <div className="border-b border-surface-800 bg-surface-900 px-3 py-3">
      <div className="mb-2 px-0.5 text-[12px] font-bold text-surface-400">{t('projectFiles')}</div>
      <div className="block text-[11px] font-bold text-surface-500">{t('project')}
        <button
          type="button"
          onClick={() => setMobileProjectPickerOpen(true)}
          className="mt-1.5 flex min-h-10 w-full items-center gap-2 rounded-xl border border-surface-700 bg-surface-950 px-3 text-left text-sm font-bold text-surface-100 outline-none focus:border-primary-500"
          aria-label={t('selectProjectForFiles')}
        >
          <span className="min-w-0 flex-1 truncate">{activeFileProject?.agent?.displayName || activeFileProject?.name || t('selectProject')}</span>
          <span className="shrink-0 text-surface-500" aria-hidden="true">›</span>
        </button>
      </div>
    </div>
  )}
  {mobileQuickFilesView === null && <div className="flex min-h-0 flex-1 flex-col space-y-1 px-2">
    {!isMobile && (
      <SessionFilesMenuSection
        activeSessionId={activeSessionId}
        placement="sidebar"
        onFileClick={onFileClick}
      />
    )}
    {/* Files is quick navigation for the current Agent project. */}
    {activeFileProject ? (
      <>
        <DeferredSidebarSurface><LazyFilesToolbar
          onRefresh={onRequestFileTree}
          project={activeFileProject}
          query={fileSearchQuery}
          onQueryChange={setFileSearchQuery}
        /></DeferredSidebarSurface>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!isMobile && <div className="mb-1 mt-2 shrink-0 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-surface-600">{t('workspaceFiles')}</div>}
          <div data-sidebar-files-scroll="true" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
            {fileSearchQuery.trim().length >= 2 ? (
              <DeferredSidebarSurface><LazySidebarFileSearchResults
                rootPath={activeFileProject.rootPath || ''}
                query={fileSearchQuery.trim()}
                results={fileSearchResults}
                loading={fileSearchLoading}
                error={fileSearchError}
                onFileClick={onFileClick}
                onClear={() => setFileSearchQuery('')}
              /></DeferredSidebarSurface>
            ) : (
              <SidebarProjectFiles
                key={activeFileProject.id}
                project={activeFileProject}
                onFileClick={onFileClick}
                onPinFile={onPinFile}
                onNewSessionInFolder={onNewSessionInFolder}
              />
            )}
          </div>
        </div>
    </>
    ) : (
      <div className="mx-2 mt-3 rounded-lg border border-surface-800 px-3 py-4 text-sm text-surface-500">{t('selectAiTeammateForFiles')}</div>
    )}

  </div>}
  </div>
</div>
  );
}
