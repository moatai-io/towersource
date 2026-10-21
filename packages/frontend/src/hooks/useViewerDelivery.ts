import { useCallback, useEffect } from 'react';
import type { TFunction } from 'i18next';
import { useChatStore } from '../stores/chat-store';
import { useFileStore } from '../stores/file-store';
import { useSessionStore } from '../stores/session-store';
import { sessionAttachmentContentUrl, sessionAttachmentIdFromUri } from '../utils/session-attachment-links';
import { toastError } from '../utils/toast';
import {
  consumeSessionViewerDelivery,
  hasConsumedSessionViewerDelivery,
  markSessionViewerDeliveryConsumed,
  queueSessionViewerDelivery,
  type SessionViewerDelivery,
} from '../features/viewer-delivery/sessionViewerDelivery';

type FileOpenOptions = {
  split?: 'right' | 'bottom';
  target?: 'main' | 'viewer';
  backgroundViewer?: boolean;
  revealViewer?: boolean;
  name?: string;
};

type Options = {
  activeSessionId: string | null;
  handleFileClick: (path: string, options?: FileOpenOptions) => void;
  revealPersonalViewer: () => void;
  openPersonalFileInViewer: (uri: string) => Promise<void>;
  openPersonalMaterialsInViewer: () => void;
  openPersonalTodosInViewer: () => void;
  openPersonalArchiveInViewer: () => void;
  t: TFunction<'layout'>;
};

export function useViewerDelivery({
  activeSessionId,
  handleFileClick,
  revealPersonalViewer,
  openPersonalFileInViewer,
  openPersonalMaterialsInViewer,
  openPersonalTodosInViewer,
  openPersonalArchiveInViewer,
  t,
}: Options) {
  const handleMessageFileClick = useCallback((path: string) => {
    if (sessionAttachmentIdFromUri(path)) {
      const sessionId = useChatStore.getState().sessionId || useSessionStore.getState().activeSessionId || '';
      const token = localStorage.getItem('token');
      const contentUrl = sessionAttachmentContentUrl(sessionId, path, token);
      if (!contentUrl) {
        toastError(t('attachmentSessionNotFound'));
        return;
      }
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const metadataUrl = contentUrl.replace(/\/content(?=\?|$)/, '');
      fetch(metadataUrl, { headers })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || t('attachmentLoadFailedWithStatus', { status: response.status }));
          const attachment = data.attachment || {};
          const language = String(attachment.mimeType || '').startsWith('image/') ? 'image' : 'text';
          useFileStore.getState().setContextPanelOpen(true);
          useFileStore.getState().setActiveFilePane('extra');
          useFileStore.getState().openTab(contentUrl, '', language, 'utf-8', {
            split: 'right', name: attachment.name || t('attachment'),
          });
          if (useSessionStore.getState().isMobile) useSessionStore.getState().openMobileContext();
        })
        .catch((error) => toastError(error instanceof Error ? error.message : t('attachmentOpenFailed')));
      return;
    }
    handleFileClick(path, { split: 'right' });
  }, [handleFileClick, t]);

  const presentViewerDelivery = useCallback((delivery: SessionViewerDelivery, alreadyConsumed = false) => {
    if (!alreadyConsumed && hasConsumedSessionViewerDelivery(delivery.deliveryId)) return;
    if (!alreadyConsumed) markSessionViewerDeliveryConsumed(delivery.deliveryId);
    handleFileClick(delivery.path, {
      split: 'right', target: 'viewer', backgroundViewer: !delivery.focus, revealViewer: delivery.reveal, name: delivery.label,
    });
  }, [handleFileClick]);

  useEffect(() => {
    const presentFileHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; deliveryId?: string; path?: string; label?: string; focus?: boolean; reveal?: boolean }>).detail;
      if (!detail?.path || !detail.sessionId) return;
      const delivery: SessionViewerDelivery = {
        deliveryId: detail.deliveryId || `${detail.sessionId}:${detail.path}`,
        sessionId: detail.sessionId,
        path: detail.path,
        label: detail.label,
        focus: detail.focus !== false,
        reveal: detail.reveal === true,
      };
      if (delivery.sessionId !== useSessionStore.getState().activeSessionId) {
        // A background result belongs to its originating conversation. Keep it
        // there as a quiet delivery, never steal focus during later navigation.
        queueSessionViewerDelivery({ ...delivery, focus: false, reveal: false });
        return;
      }
      presentViewerDelivery(delivery);
    };
    const openPathHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; split?: 'right' | 'bottom' }>).detail;
      const path = detail?.path;
      if (!path) return;
      if (path === 'personal://todos') return openPersonalTodosInViewer();
      if (path === 'personal://materials' || path === 'personal://documents') {
        if (path === 'personal://materials' && useSessionStore.getState().isMobile) {
          useFileStore.getState().openTab('personal://materials', '', 'personal-materials', 'utf-8', {
            forceNew: true, split: 'right', name: t('myMaterials'),
          });
          revealPersonalViewer();
          return;
        }
        openPersonalMaterialsInViewer();
        return;
      }
      if (path === 'personal://archive') return openPersonalArchiveInViewer();
      if (path.startsWith('personal://')) {
        void openPersonalFileInViewer(path).catch((error) => {
          toastError(error instanceof Error ? error.message : t('personalFileOpenFailed'));
        });
        return;
      }
      handleFileClick(path, detail?.split ? { split: 'right' } : undefined);
    };
    window.addEventListener('tower-present-file', presentFileHandler as EventListener);
    window.addEventListener('tower-open-path', openPathHandler as EventListener);
    return () => {
      window.removeEventListener('tower-present-file', presentFileHandler as EventListener);
      window.removeEventListener('tower-open-path', openPathHandler as EventListener);
    };
  }, [handleFileClick, openPersonalArchiveInViewer, openPersonalFileInViewer, openPersonalMaterialsInViewer, openPersonalTodosInViewer, presentViewerDelivery, revealPersonalViewer, t]);

  useEffect(() => {
    if (!activeSessionId) return;
    const pending = consumeSessionViewerDelivery(activeSessionId);
    if (pending) presentViewerDelivery(pending, true);
  }, [activeSessionId, presentViewerDelivery]);

  return { handleMessageFileClick };
}
