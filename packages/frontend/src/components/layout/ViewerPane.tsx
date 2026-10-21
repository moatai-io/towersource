import { towerHttpUrl } from '../../features/client-connection/connection';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { ShareModal } from '../files/ShareModal';
import { useResizablePane } from '../../hooks/useResizablePane';
import { useFileStore } from '../../stores/file-store';
import { usePinStore } from '../../stores/pin-store';
import { toastQuiet } from '../../utils/toast';
import { ViewportContextMenu } from '../common/ViewportContextMenu';
import { ContextPanel } from './ContextPanel';
import { FileTabChip, SortableTabShell } from './FileTabBar';

const VIEWER_PANE_MIN_WIDTH = 220;
const VIEWER_PANE_MAX_WIDTH = 1800;
const VIEWER_PANE_MAIN_MIN_WIDTH = 280;
const VIEWER_PANE_MAX_VIEWPORT_RATIO = 0.86;
const VIEWER_PANE_STORAGE_KEY = 'tower.viewerPaneWidth';
const VIEWER_PANE_MODE_STORAGE_KEY = 'tower.viewerPaneWidthMode';
const VIEWER_PANE_REGULAR_RATIO = 0.4;
const VIEWER_PANE_SPLIT_RATIO = 0.65;

type ViewerTabMenu = { x: number; y: number; id: string };

interface ViewerPaneProps {
  sidebarWidth: number;
  activeView: string;
  isMobile: boolean;
  artifactFlashActive: boolean;
  onCreatePersonalNote: () => void | Promise<void>;
  onSaveFile: (path: string, content: string) => void;
  onReloadFile: (path: string) => void;
  onRenamePersonalFile: (uri: string, title: string) => Promise<void>;
  onFileNavigate: (path: string) => void;
  onOpenInBrowserTab: (path: string) => void;
  onPinFile: (path: string) => void | Promise<void>;
  onUnpinFile: (id: number) => void | Promise<void>;
}

export function ViewerPane({
  sidebarWidth,
  activeView,
  isMobile,
  artifactFlashActive,
  onCreatePersonalNote,
  onSaveFile,
  onReloadFile,
  onRenamePersonalFile,
  onFileNavigate,
  onOpenInBrowserTab,
  onPinFile,
  onUnpinFile,
}: ViewerPaneProps) {
  const { t } = useTranslation('layout');
  const splitTabId = useFileStore((state) => state.splitTabId);
  const contextPanelOpen = useFileStore((state) => state.contextPanelOpen);
  const setContextPanelOpen = useFileStore((state) => state.setContextPanelOpen);
  const contextPanelTab = useFileStore((state) => state.contextPanelTab);
  const activeViewerTabLanguage = useFileStore((state) => state.splitTabId
    ? state.tabs.find((tab) => tab.id === state.splitTabId)?.language ?? null
    : null);
  const extraTabs = useFileStore(useShallow((state) => state.tabs.filter((tab) => tab.pane === 'extra' || tab.id === state.splitTabId)));
  const reorderTabs = useFileStore((state) => state.reorderTabs);
  const setActiveFilePane = useFileStore((state) => state.setActiveFilePane);
  const [tabMenu, setTabMenu] = useState<ViewerTabMenu | null>(null);
  const [shareFilePath, setShareFilePath] = useState<string | null>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const resizeGuideRef = useRef<HTMLDivElement>(null);
  const [tabbarOverflow, setTabbarOverflow] = useState({ left: false, right: false });

  const calculateViewerPaneMaxWidth = useCallback(() => {
    const availableWidth = Math.max(VIEWER_PANE_MIN_WIDTH, window.innerWidth - sidebarWidth - 80);
    const viewportRatioMax = Math.floor(availableWidth * VIEWER_PANE_MAX_VIEWPORT_RATIO);
    const mainPreservingMax = availableWidth - VIEWER_PANE_MAIN_MIN_WIDTH;
    return Math.max(VIEWER_PANE_MIN_WIDTH, Math.min(VIEWER_PANE_MAX_WIDTH, viewportRatioMax, mainPreservingMax));
  }, [sidebarWidth]);
  const calculateViewerPaneWidth = useCallback((ratio: number) => {
    const availableWidth = Math.max(VIEWER_PANE_MIN_WIDTH, window.innerWidth - sidebarWidth - 80);
    return Math.min(calculateViewerPaneMaxWidth(), Math.max(VIEWER_PANE_MIN_WIDTH, Math.round(availableWidth * ratio)));
  }, [calculateViewerPaneMaxWidth, sidebarWidth]);
  const [paneWidth, setPaneWidth] = useState(() => {
    const parsed = Number(localStorage.getItem(VIEWER_PANE_STORAGE_KEY));
    if (!Number.isFinite(parsed) || parsed <= 0) return calculateViewerPaneWidth(VIEWER_PANE_REGULAR_RATIO);
    return Math.min(VIEWER_PANE_MAX_WIDTH, Math.max(VIEWER_PANE_MIN_WIDTH, parsed));
  });
  const [paneWidthMode, setPaneWidthMode] = useState<'regular' | 'split'>(() => (
    localStorage.getItem(VIEWER_PANE_MODE_STORAGE_KEY) === 'split' ? 'split' : 'regular'
  ));
  const isMarkdownSplitViewer = contextPanelOpen && activeViewerTabLanguage === 'markdown' && contextPanelTab === 'split';

  useEffect(() => {
    const desiredMode = isMarkdownSplitViewer ? 'split' : 'regular';
    if (paneWidthMode === desiredMode) return;
    const nextWidth = calculateViewerPaneWidth(desiredMode === 'split' ? VIEWER_PANE_SPLIT_RATIO : VIEWER_PANE_REGULAR_RATIO);
    setPaneWidth(nextWidth);
    localStorage.setItem(VIEWER_PANE_STORAGE_KEY, String(nextWidth));
    localStorage.setItem(VIEWER_PANE_MODE_STORAGE_KEY, desiredMode);
    setPaneWidthMode(desiredMode);
  }, [calculateViewerPaneWidth, isMarkdownSplitViewer, paneWidthMode]);

  const updateTabbarOverflow = useCallback(() => {
    const element = tabbarRef.current;
    if (!element) return;
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setTabbarOverflow({ left: element.scrollLeft > 2, right: element.scrollLeft < maxScrollLeft - 2 });
  }, []);
  const scrollTabbarBy = useCallback((direction: -1 | 1) => {
    tabbarRef.current?.scrollBy({ left: direction * 180, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const element = tabbarRef.current;
    if (!element) return;
    updateTabbarOverflow();
    element.addEventListener('scroll', updateTabbarOverflow, { passive: true });
    const resizeObserver = new ResizeObserver(updateTabbarOverflow);
    resizeObserver.observe(element);
    return () => {
      element.removeEventListener('scroll', updateTabbarOverflow);
      resizeObserver.disconnect();
    };
  }, [extraTabs.length, paneWidth, updateTabbarOverflow]);

  useEffect(() => {
    if (!splitTabId) return;
    window.requestAnimationFrame(() => {
      const tab = tabbarRef.current?.querySelector<HTMLElement>(`[data-viewer-tab-id="${CSS.escape(splitTabId)}"]`);
      tab?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      updateTabbarOverflow();
    });
  }, [splitTabId, updateTabbarOverflow]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: isMobile ? { delay: 180, tolerance: 8 } : { distance: 6 } }));
  const handleTabDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id).replace(/^viewer-file:/, '');
    const targetId = String(over.id).replace(/^viewer-file:/, '');
    const tabs = useFileStore.getState().tabs;
    const fromIndex = tabs.findIndex((tab) => tab.id === activeId);
    const toIndex = tabs.findIndex((tab) => tab.id === targetId);
    if (fromIndex >= 0 && toIndex >= 0) reorderTabs(fromIndex, toIndex);
  }, [reorderTabs]);

  const { isResizing, startResize } = useResizablePane({
    value: paneWidth,
    calculateValue: ({ clientX, startX, startValue }) => Math.min(
      calculateViewerPaneMaxWidth(),
      Math.max(VIEWER_PANE_MIN_WIDTH, startValue - (clientX - startX)),
    ),
    onPreview: (nextWidth, startWidth) => {
      if (resizeGuideRef.current) resizeGuideRef.current.style.transform = `translate3d(${startWidth - nextWidth}px, 0, 0)`;
    },
    onResizeEnd: (nextWidth) => {
      setPaneWidth(nextWidth);
      localStorage.setItem(VIEWER_PANE_STORAGE_KEY, String(Math.round(nextWidth)));
    },
  });

  if (activeView === 'schedules') return null;

  return (
    <>
      {splitTabId && contextPanelOpen ? (
        <>
          <div role="separator" aria-orientation="vertical" aria-label={t('resizeViewer')} title={t('resizeViewerHint')} onPointerDown={startResize} className="group relative z-20 w-2 shrink-0 cursor-col-resize bg-surface-950">
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-surface-700/70 transition-colors group-hover:bg-primary-400" />
            <div className="absolute inset-y-0 left-1/2 w-5 -translate-x-1/2" />
          </div>
          <main data-tour-id="viewer-pane" className="min-w-0 shrink-0 flex justify-center contain-layout" style={{ width: paneWidth }}>
            <div onMouseDown={() => setActiveFilePane('extra')} className={`tower-main-shell tower-artifact-shell tower-viewer-shell relative overflow-hidden w-full flex flex-col h-full shadow-xl shadow-black/10 bg-surface-950 ${artifactFlashActive ? 'tower-artifact-flash' : ''}`}>
              <div className="tower-main-tabbar flex shrink-0 items-end bg-surface-950/45 px-1.5 pt-1.5 pb-0 text-sm leading-none select-none">
                <div className="tower-viewer-label flex h-7 shrink-0 items-center px-2 text-[12px] font-medium text-surface-300" title={t('viewerDescription')}>{t('viewer')}</div>
                <div className="relative min-w-0 flex-1">
                  <div ref={tabbarRef} className="min-w-0 overflow-x-auto scrollbar-none">
                    <div className="flex min-w-full items-end gap-0.5">
                      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleTabDragEnd}>
                        <SortableContext items={extraTabs.map((tab) => `viewer-file:${tab.id}`)} strategy={horizontalListSortingStrategy}>
                          {extraTabs.map((tab) => (
                            <div key={tab.id} data-viewer-tab-id={tab.id} className="min-w-[5.5rem] max-w-[14rem] flex-[1_1_0]">
                              <SortableTabShell id={`viewer-file:${tab.id}`} className="!min-w-0 !flex-1">
                                <FileTabChip tab={tab} isActive={tab.id === splitTabId} isMobile={isMobile} onSelect={() => useFileStore.getState().openSplitTab(tab.id, 'right')} onClose={() => useFileStore.getState().closeTab(tab.id)} onPin={() => { useFileStore.getState().pinTab(tab.id); toastQuiet(tab.pinned ? t('tabUnpinned') : t('tabPinned')); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setTabMenu({ x: event.clientX, y: event.clientY, id: tab.id }); }} className="!min-w-0 !max-w-none !flex-1" />
                              </SortableTabShell>
                            </div>
                          ))}
                        </SortableContext>
                      </DndContext>
                    </div>
                  </div>
                  {tabbarOverflow.left ? <button type="button" onClick={() => scrollTabbarBy(-1)} aria-label={t('moreViewerTabsLeft')} className="absolute left-0 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-surface-700/70 bg-surface-900/90 text-[15px] text-surface-300 shadow-sm transition hover:border-surface-500 hover:bg-surface-800 hover:text-surface-50">‹</button> : null}
                  {tabbarOverflow.right ? <button type="button" onClick={() => scrollTabbarBy(1)} aria-label={t('moreViewerTabsRight')} className="absolute right-0 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-surface-700/70 bg-surface-900/90 text-[15px] text-surface-300 shadow-sm transition hover:border-surface-500 hover:bg-surface-800 hover:text-surface-50">›</button> : null}
                </div>
                <button type="button" onClick={() => { void onCreatePersonalNote(); }} className="tower-viewer-new-note flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[18px] text-surface-300 transition hover:bg-surface-800 hover:text-surface-50" title={t('createBlankPersonalNote')} aria-label={t('createBlankPersonalNote')}>+</button>
                <button type="button" data-tour-id="viewer-collapse" onClick={() => setContextPanelOpen(false)} className="tower-viewer-collapse ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-surface-400 transition hover:bg-surface-800 hover:text-surface-100" title={t('hideViewer')} aria-label={t('hideViewer')}>
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
              <ErrorBoundary fallbackLabel="Viewer pane error"><div className="flex-1 flex flex-col min-h-0"><ContextPanel tabId={splitTabId} onSave={onSaveFile} onReload={onReloadFile} onRenamePersonalFile={onRenamePersonalFile} onFileNavigate={onFileNavigate} hideTabBar fullScreen /></div></ErrorBoundary>
            </div>
          </main>
          {isResizing ? <div className="fixed inset-0 z-[9998] cursor-col-resize" aria-hidden="true"><div ref={resizeGuideRef} className="absolute inset-y-0 w-px bg-primary-400 shadow-[0_0_0_1px_rgba(0,0,0,0.3)] will-change-transform" style={{ right: paneWidth + 8 }} /></div> : null}
        </>
      ) : (
        <button type="button" onClick={() => { if (extraTabs.length > 0) { const nextTabId = splitTabId || extraTabs[0]?.id; if (nextTabId) useFileStore.getState().openSplitTab(nextTabId, 'right'); setContextPanelOpen(true); return; } void onCreatePersonalNote(); }} className="tower-viewer-reopen-handle group flex w-9 shrink-0 flex-col items-center justify-center border-l text-surface-400 transition hover:text-surface-100" title={splitTabId ? t('reopenViewer') : t('createBlankPersonalNote')} aria-label={splitTabId ? t('reopenViewer') : t('createBlankPersonalNote')}>
          <span className="mb-4 rotate-90 whitespace-nowrap text-[12px] font-medium tracking-wide">{t('viewer')}</span><span className="rounded-full border border-surface-700 px-1.5 py-0.5 text-[11px] group-hover:border-surface-500">{extraTabs.length > 0 ? extraTabs.length : '+'}</span>
        </button>
      )}
      {shareFilePath ? <ShareModal filePath={shareFilePath} onClose={() => setShareFilePath(null)} /> : null}
      {tabMenu ? <ViewerTabContextMenu menu={tabMenu} onClose={() => setTabMenu(null)} onOpenInBrowserTab={onOpenInBrowserTab} onShare={setShareFilePath} onPinFile={onPinFile} onUnpinFile={onUnpinFile} /> : null}
    </>
  );
}

function ViewerTabContextMenu({ menu, onClose, onOpenInBrowserTab, onShare, onPinFile, onUnpinFile }: { menu: ViewerTabMenu; onClose: () => void; onOpenInBrowserTab: (path: string) => void; onShare: (path: string) => void; onPinFile: (path: string) => void | Promise<void>; onUnpinFile: (id: number) => void | Promise<void> }) {
  const { t } = useTranslation('layout');
  const tab = useFileStore.getState().tabs.find((candidate) => candidate.id === menu.id);
  const favorite = tab ? usePinStore.getState().pins.find((pin) => pin.file_path === tab.path) : undefined;
  const itemClass = 'w-full min-h-[44px] px-4 py-2 text-left hover:bg-surface-800';
  const closeThen = (action: () => void | Promise<void>) => { onClose(); void action(); };
  return (
    <ViewportContextMenu x={menu.x} y={menu.y} className="fixed z-50 min-w-[180px] py-1 bg-surface-900 border border-surface-700 rounded-md shadow-xl text-base text-gray-200" role="menu" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <button onClick={() => closeThen(() => { if (tab) window.dispatchEvent(new CustomEvent('tower-reveal-tab-target', { detail: { kind: 'file', path: tab.path } })); })} className={itemClass}>{t('goToFolder')}</button>
      <button onClick={() => closeThen(() => { if (tab) onOpenInBrowserTab(tab.path); })} className={itemClass}>{t('openInNewBrowserTab')}</button>
      <button onClick={() => closeThen(() => { if (!tab) return; const token = localStorage.getItem('token'); window.open(towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(tab.path)}&download=1${token ? `&token=${encodeURIComponent(token)}` : ''}`), '_blank'); })} className={itemClass}>{t('download')}</button>
      <button onClick={() => closeThen(() => { if (tab) onShare(tab.path); })} className={itemClass}>{t('share')}</button>
      <button onClick={() => closeThen(async () => { if (!tab) return; try { await navigator.clipboard.writeText(tab.path); toastQuiet(t('pathCopied')); } catch { toastQuiet(t('pathCopyFailed')); } })} className={itemClass}>{t('copyPath')}</button>
      <div className="my-1 h-px bg-surface-800" />
      <button onClick={() => closeThen(() => favorite ? onUnpinFile(favorite.id) : tab ? onPinFile(tab.path) : undefined)} className={itemClass}>{favorite ? t('removeFromFavorites') : t('addToFavorites')}</button>
      <div className="my-1 h-px bg-surface-800" />
      <button onClick={() => closeThen(() => useFileStore.getState().moveTabToPane(menu.id, 'main'))} className={`${itemClass} flex items-center justify-between gap-3`}><span>{t('moveToMainTab')}</span><span className="text-[12px] text-gray-500">↙</span></button>
      <div className="my-1 h-px bg-surface-800" />
      <button onClick={() => closeThen(() => useFileStore.getState().closeTab(menu.id))} className={itemClass}>{t('closeTab')}</button>
      <div className="my-1 h-px bg-surface-800" />
      <button onClick={() => closeThen(() => { if (!tab) return; useFileStore.getState().pinTab(menu.id); toastQuiet(tab.pinned ? t('tabUnpinned') : t('tabPinned')); })} className={`${itemClass} flex items-center justify-between gap-3`}><span>{tab?.pinned ? t('unpinTab') : t('pinTab')}</span><span className="text-[12px] text-gray-500">{t('doubleClick')}</span></button>
    </ViewportContextMenu>
  );
}
