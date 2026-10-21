import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chat-store';
import { dismissChatRequestFailure, useChatFeedback } from './feedback';

/** Owns surface, delay, lifetime and precedence; callers do not choose toast vs inline. */
export function ChatFeedback({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('common');
  const connected = useChatFeedback(s => s.connected);
  const requestFailed = useChatFeedback(s => !!sessionId && !!s.requests[sessionId]);
  const turn = useChatStore(s => sessionId ? s.turnStateBySession[sessionId] : undefined);
  const [showDisconnect, setShowDisconnect] = useState(false);
  useEffect(() => {
    if (connected) { setShowDisconnect(false); return; }
    const timer = setTimeout(() => setShowDisconnect(true), 1500);
    return () => clearTimeout(timer);
  }, [connected]);
  useEffect(() => {
    if (!sessionId || !requestFailed) return;
    if (turn?.phase === 'preparing') { dismissChatRequestFailure(sessionId); return; }
    const timer = setTimeout(() => dismissChatRequestFailure(sessionId), 8000);
    return () => clearTimeout(timer);
  }, [sessionId, requestFailed, turn?.phase]);
  const message = !connected
    ? (showDisconnect ? t('chatFeedback.reconnecting') : null)
    : turn?.phase === 'error'
      ? (turn.errorMessage || t('chatRuntimeError.default'))
      : requestFailed ? t('chatFeedback.requestFailed') : null;
  if (!message) return null;
  return <div role="status" aria-live="polite" className="mx-4 my-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">
    {message}
    {connected && turn?.phase === 'error' && <p className="mt-1">{t('chatFeedback.recovery')}</p>}
  </div>;
}
