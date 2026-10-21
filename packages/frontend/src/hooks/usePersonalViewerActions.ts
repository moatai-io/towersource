import { saveFileOperation } from '../features/file-operation-feedback/save-operation';
import { acknowledgeFileSave } from '../features/file-operation-feedback/save-acknowledgement';
import { useCallback, useRef } from 'react';
import type { TFunction } from 'i18next';
import { useFileStore } from '../stores/file-store';
import { useSessionStore } from '../stores/session-store';
import { recordRecentPersonalDocument, recordServerPersonalDocumentOpened } from '../components/personal-space/personalDocumentRecents';
import { toastError, toastSuccess } from '../utils/toast';

const API_BASE = '/api';

type Options = {
  token: string | null;
  requestFile: (path: string) => void;
  triggerArtifactFlash: () => void;
  t: TFunction<'layout'>;
};

export function usePersonalViewerActions({ token, requestFile, triggerArtifactFlash, t }: Options) {
  const personalFileVersionsRef = useRef(new Map<string, number>());

  const revealPersonalViewer = useCallback(() => {
    if (useSessionStore.getState().isMobile) useSessionStore.getState().openMobileContext();
  }, []);

  const openPersonalFileInViewer = useCallback(async (uri: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const listResponse = await fetch(`${API_BASE}/personal-space/files`, { headers });
    const listed = await listResponse.json().catch(() => ({}));
    const metadata = Array.isArray(listed.files) ? listed.files.find((file: any) => file.uri === uri) : null;
    if (metadata?.kind === 'file') {
      const contentUrl = `${API_BASE}/personal-space/files/content?uri=${encodeURIComponent(uri)}`;
      useFileStore.getState().openTab(contentUrl, '', 'url', 'utf-8', {
        forceNew: true, split: 'right', name: metadata.name || t('viewMyFiles'),
      });
      revealPersonalViewer();
      recordRecentPersonalDocument(uri);
      void recordServerPersonalDocumentOpened(uri).catch(() => {});
      triggerArtifactFlash();
      return;
    }
    const response = await fetch(`${API_BASE}/personal-space/files/read?uri=${encodeURIComponent(uri)}`, { headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || t('personalNoteLoadFailedWithStatus', { status: response.status }));
    const resolvedUri = data.uri || uri;
    if (Number.isInteger(data.version)) personalFileVersionsRef.current.set(resolvedUri, data.version);
    useFileStore.getState().openTab(resolvedUri, typeof data.content === 'string' ? data.content : '', 'markdown', 'utf-8', {
      forceNew: true, split: 'right', name: data.name || t('personalNoteTitleAndFilename'),
    });
    revealPersonalViewer();
    recordRecentPersonalDocument(resolvedUri);
    void recordServerPersonalDocumentOpened(resolvedUri).catch(() => {});
    triggerArtifactFlash();
  }, [revealPersonalViewer, t, token, triggerArtifactFlash]);

  const openPersonalMaterialsInViewer = useCallback(() => {
    const mobile = useSessionStore.getState().isMobile;
    useFileStore.getState().openTab(mobile ? 'personal://documents' : 'personal://materials', '', mobile ? 'personal-documents' : 'personal-materials', 'utf-8', {
      forceNew: true, split: 'right', name: mobile ? t('myDocuments') : t('myMaterials'),
    });
    revealPersonalViewer();
    triggerArtifactFlash();
  }, [revealPersonalViewer, t, triggerArtifactFlash]);

  const openPersonalTodosInViewer = useCallback(() => {
    useFileStore.getState().openTab('personal://todos', '', 'personal-todos', 'utf-8', {
      forceNew: true, split: 'right', name: t('myTodo'),
    });
    revealPersonalViewer();
    triggerArtifactFlash();
  }, [revealPersonalViewer, t, triggerArtifactFlash]);

  const openPersonalArchiveInViewer = useCallback(() => {
    useFileStore.getState().openTab('personal://archive', '', 'personal-archive', 'utf-8', {
      forceNew: true, split: 'right', name: t('archive'),
    });
    revealPersonalViewer();
    triggerArtifactFlash();
  }, [revealPersonalViewer, t, triggerArtifactFlash]);

  const handleReloadFile = useCallback((path: string) => {
    if (path.startsWith('personal://')) {
      void openPersonalFileInViewer(path).catch((error) => {
        toastError(error instanceof Error ? error.message : t('personalNoteReloadFailed'));
      });
      return;
    }
    requestFile(path);
  }, [openPersonalFileInViewer, requestFile, t]);

  const handleRenamePersonalFile = useCallback(async (uri: string, title: string) => {
    const relativePath = uri.slice('personal://'.length);
    const slash = relativePath.lastIndexOf('/');
    const parent = slash >= 0 ? relativePath.slice(0, slash + 1) : '';
    const nextPath = `${parent}${title}.md`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${API_BASE}/personal-space/files/rename`, {
      method: 'POST', headers, body: JSON.stringify({ uri, nextPath }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error || t('personalNoteRenameFailedWithStatus', { status: response.status });
      toastError(message);
      throw new Error(message);
    }
    const nextUri = data.uri || `personal://${nextPath}`;
    const previousVersion = personalFileVersionsRef.current.get(uri);
    personalFileVersionsRef.current.delete(uri);
    if (Number.isInteger(data.version)) personalFileVersionsRef.current.set(nextUri, data.version);
    else if (previousVersion != null) personalFileVersionsRef.current.set(nextUri, previousVersion + 1);
    useFileStore.getState().renameOpenTabPath(uri, nextUri, data.name || `${title}.md`);
    toastSuccess(t('personalNoteRenamed'));
  }, [t, token]);

  const handleCreatePersonalNote = useCallback(async () => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${API_BASE}/personal-space/files/create-note`, {
        method: 'POST', headers, body: JSON.stringify({ content: '' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t('personalNoteCreateFailedWithStatus', { status: response.status }));
      await openPersonalFileInViewer(data.uri);
      useFileStore.getState().setContextPanelTab('write');
      toastSuccess(t('blankPersonalNoteOpened'));
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('personalNoteCreateFailed'));
    }
  }, [openPersonalFileInViewer, t, token]);

  const savePersonalFile = useCallback(async (path: string, content: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    await saveFileOperation(path, async () => {
      const response = await fetch(`${API_BASE}/personal-space/files/write`, {
        method: 'PUT', headers,
        body: JSON.stringify({ uri: path, content, expectedVersion: personalFileVersionsRef.current.get(path) }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && Number.isInteger(data.version)) personalFileVersionsRef.current.set(path, data.version);
      return response;
    }, () => acknowledgeFileSave(path, content));
  }, [t, token]);

  return {
    revealPersonalViewer,
    openPersonalFileInViewer,
    openPersonalMaterialsInViewer,
    openPersonalTodosInViewer,
    openPersonalArchiveInViewer,
    handleReloadFile,
    handleRenamePersonalFile,
    handleCreatePersonalNote,
    savePersonalFile,
  };
}
