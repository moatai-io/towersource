import { useEffect, useRef } from 'react';
import { useChatStore } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';
import { toastInfo } from '../../utils/toast';

/** Resolve an explicit message anchor before the viewport's existing scroll effect runs. */
export function useMessageAnchorHistory(options: {
  sessionId: string | null;
  hash: string;
  ready: boolean;
  targetReady: boolean;
  loadMore?: (sessionId: string) => Promise<void>;
}) {
  const { sessionId, hash, ready, targetReady, loadMore } = options;
  const generation = useRef(0);
  useEffect(() => {
    const run = ++generation.current;
    const match = /^#m-([a-z2-9]{8})$/.exec(hash);
    if (!sessionId || !match || !ready || targetReady || !loadMore) return;
    let cancelled = false;
    const current = () => !cancelled && generation.current === run
      && useSessionStore.getState().activeSessionId === sessionId
      && window.location.hash === hash;
    void (async () => {
      while (current()) {
        const before = useChatStore.getState();
        if (before.sessionId !== sessionId || before.sessionLoading) return;
        if (before.messages.some(message => message.shortId === match[1])) return;
        if (!before.hasMoreMessages) {
          toastInfo('링크가 가리키는 메시지를 찾을 수 없습니다. 삭제되었거나 더 이상 제공되지 않는 대화일 수 있습니다.');
          return;
        }
        // Another history reader owns this request; wait for its store update.
        if (before.loadingMoreMessages) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        const cursor = before.oldestMessageId;
        try { await loadMore(sessionId); } catch { /* Report below without retrying. */ }
        if (!current()) return;
        const after = useChatStore.getState();
        if (after.messages.some(message => message.shortId === match[1])) return;
        if (after.hasMoreMessages && after.oldestMessageId === cursor) {
          toastInfo('이전 대화를 불러오지 못해 링크 위치로 이동하지 못했습니다. 링크를 다시 열어 주세요.');
          return;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, hash, ready, targetReady, loadMore]);
}
