import { useCallback, useState } from 'react';
import type { TFunction } from 'i18next';
import type { Pin } from '../stores/pin-store';
import { usePinStore } from '../stores/pin-store';
import type { PromptItem } from '../stores/prompt-store';
import { usePromptStore } from '../stores/prompt-store';
import { useFileStore } from '../stores/file-store';
import { useSessionStore } from '../stores/session-store';
import { toastQuiet } from '../utils/toast';

const API_BASE = '/api';

type UseAppCollectionsOptions = {
  token: string | null;
  requestFile: (path: string) => void;
  requestFileTree: (path?: string) => void;
  t: TFunction<'layout'>;
};

export function useAppCollections({ token, requestFile, requestFileTree, t }: UseAppCollectionsOptions) {
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<PromptItem | null>(null);

  const handlePinFile = useCallback(async (filePath: string, kind: 'file' | 'folder' = 'file') => {
    try {
      const existing = usePinStore.getState().pins.find((pin) => pin.file_path === filePath);
      if (existing) {
        toastQuiet(t('alreadyInFavorites'));
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const name = filePath.split('/').pop() || filePath;
      const ext = kind === 'folder' ? '' : (filePath.split('.').pop()?.toLowerCase() || '');
      const typeMap: Record<string, string> = {
        md: 'markdown', html: 'html', htm: 'html', txt: 'text',
        py: 'python', ts: 'typescript', tsx: 'typescript',
        js: 'javascript', jsx: 'javascript', json: 'json',
      };
      const response = await fetch(`${API_BASE}/pins`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: name, filePath, fileType: kind === 'folder' ? 'folder' : (typeMap[ext] || 'text') }),
      });
      if (response.ok) {
        usePinStore.getState().addPin(await response.json());
        toastQuiet(t('addedToFavorites', { name }));
      }
    } catch (error) {
      console.warn('[app] handlePinFile failed:', error);
    }
  }, [t, token]);

  const handleUnpinFile = useCallback(async (id: number) => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      await fetch(`${API_BASE}/pins/${id}`, { method: 'DELETE', headers });
      usePinStore.getState().removePin(id);
      toastQuiet(t('removedFromFavorites'));
    } catch (error) {
      console.warn('[app] handleUnpinFile failed:', error);
    }
  }, [t, token]);

  const handlePinClick = useCallback(async (pin: Pin) => {
    if (pin.file_type === 'folder') {
      requestFileTree(pin.file_path);
      useSessionStore.getState().setActiveView('chat');
      useSessionStore.getState().setSidebarTab('files');
      useSessionStore.getState().setSidebarOpen(true);
      return;
    }
    try {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${API_BASE}/files/read?path=${encodeURIComponent(pin.file_path)}`, { headers });
      if (!response.ok) {
        requestFile(pin.file_path);
        useFileStore.getState().setContextPanelTab('preview');
        return;
      }
      const data = await response.json();
      useFileStore.getState().setContextPanelTab('preview');
      useFileStore.getState().setOpenFile({
        path: data.path,
        content: data.content,
        language: data.language,
        modified: false,
        ...(data.encoding && { encoding: data.encoding }),
      });
      if (useSessionStore.getState().isMobile) useSessionStore.getState().openMobileContext();
    } catch {
      useFileStore.getState().setContextPanelTab('preview');
      requestFile(pin.file_path);
    }
  }, [requestFile, requestFileTree, token]);

  const handlePromptClick = useCallback((prompt: PromptItem) => {
    useFileStore.getState().setContextPanelTab('preview');
    useFileStore.getState().setOpenFile({
      path: `prompt:${prompt.title}`,
      content: prompt.content || '(no content)',
      language: 'markdown',
      modified: false,
    });
  }, []);

  const handlePromptAdd = useCallback(() => {
    setEditingPrompt(null);
    setPromptEditorOpen(true);
  }, []);

  const handlePromptEdit = useCallback((prompt: PromptItem) => {
    setEditingPrompt(prompt);
    setPromptEditorOpen(true);
  }, []);

  const handlePromptSave = useCallback(async (title: string, content: string) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (editingPrompt && typeof editingPrompt.id === 'number') {
        await fetch(`${API_BASE}/prompts/${editingPrompt.id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ title, content }),
        });
        usePromptStore.getState().updatePrompt(editingPrompt.id, { title, content });
      } else {
        const response = await fetch(`${API_BASE}/prompts`, {
          method: 'POST', headers, body: JSON.stringify({ title, content }),
        });
        if (response.ok) {
          const prompt = await response.json();
          usePromptStore.getState().addPrompt({
            id: prompt.id,
            title: prompt.title,
            content: prompt.content || '',
            source: 'user',
            readonly: false,
          });
        }
      }
    } catch (error) {
      console.warn('[app] handlePromptSave failed:', error);
    }
    setEditingPrompt(null);
  }, [editingPrompt, token]);

  const handlePromptDelete = useCallback(async (id: number | string) => {
    if (typeof id !== 'number') return;
    try {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      await fetch(`${API_BASE}/prompts/${id}`, { method: 'DELETE', headers });
      usePromptStore.getState().removePrompt(id);
    } catch (error) {
      console.warn('[app] handlePromptDelete failed:', error);
    }
  }, [token]);

  const closePromptEditor = useCallback(() => {
    setPromptEditorOpen(false);
    setEditingPrompt(null);
  }, []);

  return {
    promptEditorOpen,
    editingPrompt,
    closePromptEditor,
    handlePinFile,
    handleUnpinFile,
    handlePinClick,
    handlePromptClick,
    handlePromptAdd,
    handlePromptEdit,
    handlePromptSave,
    handlePromptDelete,
  };
}
