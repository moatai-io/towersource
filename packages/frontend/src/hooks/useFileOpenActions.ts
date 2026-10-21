import { useCallback, useRef } from 'react';
import type { TFunction } from 'i18next';
import { useFileStore } from '../stores/file-store';
import { useSessionStore } from '../stores/session-store';
import { recordMobileDocumentRecent } from '../components/files/mobileDocumentRecents';
import { getFileExt, isDirectoryLikeTowerPath, normalizeTowerFilePath } from '../utils/file-path-links';
import { openPdfInBrowserTab } from '../utils/pdf-open';
import { toastError } from '../utils/toast';

const API_BASE = '/api';

export type FileOpenOptions = {
  split?: 'right' | 'bottom';
  target?: 'main' | 'viewer';
  backgroundViewer?: boolean;
  /** Reveal/select the Viewer without requesting keyboard focus. */
  revealViewer?: boolean;
  name?: string;
  /** Known file from a typed listing; do not infer a directory from its name. */
  isDirectory?: boolean;
};

type Options = {
  token: string | null;
  requestFile: (path: string) => void;
  triggerArtifactFlash: () => void;
  t: TFunction<'layout'>;
};

export function useFileOpenActions({ token, requestFile, triggerArtifactFlash, t }: Options) {
  const focusedViewerRequestRef = useRef(0);

  const handleFileClick = useCallback((rawPath: string, options?: FileOpenOptions) => {
    const path = normalizeTowerFilePath(rawPath);
    const sessionAtRequest = useSessionStore.getState().activeSessionId;
    const chatEpochAtRequest = useFileStore.getState().chatNavigationEpoch;
    const openInViewer = options?.target !== 'main';
    const backgroundViewer = options?.backgroundViewer === true && options?.revealViewer !== true;
    const focusedViewerRequestId = openInViewer && !backgroundViewer
      ? ++focusedViewerRequestRef.current
      : null;
    const isPdf = path.split(/[?#]/, 1)[0].toLowerCase().endsWith('.pdf');
    if (isPdf) (window as any).__towerPdfOpenInProgressUntil = Date.now() + 5000;

    if (options?.isDirectory === true || (options?.isDirectory !== false && isDirectoryLikeTowerPath(path))) {
      window.dispatchEvent(new CustomEvent('tower-reveal-tab-target', {
        detail: { kind: 'file', path: path.replace(/\/+$/, '') },
      }));
      return;
    }

    if (getFileExt(path) === 'pdf') {
      const sessionStore = useSessionStore.getState();
      if (sessionStore.isMobile && !backgroundViewer) {
        recordMobileDocumentRecent(path, options?.name);
        openPdfInBrowserTab(path);
        return;
      }
      const fileStore = useFileStore.getState();
      if (!backgroundViewer) triggerArtifactFlash();
      if (openInViewer && !backgroundViewer) {
        fileStore.setContextPanelOpen(true);
        fileStore.setActiveFilePane('extra');
      }
      fileStore.openTab(path, '', 'pdf', 'utf-8', {
        forceNew: backgroundViewer,
        split: openInViewer ? 'right' : undefined,
        backgroundSplit: backgroundViewer,
        name: options?.name,
      });
      return;
    }

    const fileStore = useFileStore.getState();
    if (!backgroundViewer) triggerArtifactFlash();
    if (openInViewer && !backgroundViewer) {
      if (useSessionStore.getState().isMobile) recordMobileDocumentRecent(path, options?.name);
      fileStore.setContextPanelOpen(true);
      fileStore.setActiveFilePane('extra');
      if (useSessionStore.getState().isMobile) useSessionStore.getState().openMobileContext();
    }
    const existingTab = fileStore.tabs.find((tab) => tab.path === path);
    if (openInViewer) {
      if (!backgroundViewer) {
        if (existingTab) {
          fileStore.openSplitTab(existingTab.id, 'right');
        } else {
          fileStore.openTab(path, '', getFileExt(path) === 'html' ? 'html' : 'text', 'utf-8', {
            split: 'right', name: options?.name,
          });
        }
      }
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      fetch(`${API_BASE}/files/read?path=${encodeURIComponent(path)}`, { headers })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || t('fileLoadFailedWithStatus', { status: response.status }));
          const sameSession = useSessionStore.getState().activeSessionId === sessionAtRequest
            && useFileStore.getState().chatNavigationEpoch === chatEpochAtRequest;
          const isLatestFocusedViewerRequest = focusedViewerRequestId === null
            || focusedViewerRequestId === focusedViewerRequestRef.current;
          if (!sameSession) return;
          const store = useFileStore.getState();
          const resolvedPath = data.path || path;
          if (!backgroundViewer && !isLatestFocusedViewerRequest) {
            const stalePlaceholder = store.tabs.find((tab) => tab.path === path);
            if (stalePlaceholder && !stalePlaceholder.modified && stalePlaceholder.content === '') store.closeTab(stalePlaceholder.id);
            return;
          }
          store.openTab(resolvedPath, typeof data.content === 'string' ? data.content : '', data.language || 'text', data.encoding, {
            forceNew: backgroundViewer,
            split: 'right',
            backgroundSplit: backgroundViewer,
            name: options?.name,
          });
          if (!backgroundViewer && isLatestFocusedViewerRequest) {
            const opened = useFileStore.getState().tabs.find((tab) => tab.path === resolvedPath);
            if (opened) useFileStore.getState().openSplitTab(opened.id, 'right');
          }
        })
        .catch((error) => {
          if (useSessionStore.getState().activeSessionId !== sessionAtRequest
            || useFileStore.getState().chatNavigationEpoch !== chatEpochAtRequest) return;
          console.warn('[app] viewer file open failed:', error);
          toastError(error instanceof Error ? error.message : t('fileLoadFailedWithStatus', { status: 'unknown' }));
          const store = useFileStore.getState();
          const currentViewerTab = store.tabs.find((tab) => tab.path === path);
          if (!existingTab && currentViewerTab && !currentViewerTab.modified && currentViewerTab.content === '') {
            store.closeTab(currentViewerTab.id);
          } else if (currentViewerTab && !backgroundViewer) {
            store.openSplitTab(currentViewerTab.id, 'right');
          }
        });
    } else if (existingTab) {
      fileStore.setActiveTab(existingTab.id);
    } else {
      requestFile(path);
    }
  }, [requestFile, t, token, triggerArtifactFlash]);

  return { handleFileClick };
}
