import { useEffect, useRef, useCallback, useState } from 'react';
import { useChatStore } from '../stores/chat-store';
import { markSessionRunIdle } from '../features/session-run-state/session-run-actions';

type MessageHandler = (data: any) => void;
type ReconnectHandler = () => void;
export type WebSocketSendResult = 'sent' | 'queued' | false;

const STREAMING_SAFETY_TIMEOUT = 120_000; // 2 minutes — mobile backgrounding/radio handoff can exceed 30s
const ZOMBIE_CHECK_TIMEOUT = 5_000;      // 5 seconds (was 2s, too aggressive for mobile)
const PENDING_CHAT_FRAME_MAX = 5;

export function useWebSocket(url: string | null, onMessage: MessageHandler, onReconnect?: ReconnectHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnectDelay = useRef(2000);
  const onMessageRef = useRef(onMessage);
  const onReconnectRef = useRef(onReconnect);
  const wasConnected = useRef(false);
  const safetyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const safetyTimerFired = useRef(false);
  const pendingChatFrames = useRef<any[]>([]);
  // 빠른 앱 전환 시 이전 zombie 검사를 취소하기 위한 ref
  const zombieCheckAbort = useRef<AbortController | null>(null);
  onMessageRef.current = onMessage;
  onReconnectRef.current = onReconnect;

  const connect = useCallback(() => {
    // Auth-enabled boot renders once before a login token exists. Do not open an
    // unauthenticated socket that is guaranteed to fail and pollute the console;
    // the URL becomes available after login and this effect reconnects then.
    if (!url) return;
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) {
        ws.close();
        return;
      }
      setConnected(true);
      reconnectDelay.current = 2000; // Reset backoff on successful connection

      // Cancel safety timer on reconnect (keep safetyTimerFired for reconnect_result logic)
      if (safetyTimer.current) {
        clearTimeout(safetyTimer.current);
        safetyTimer.current = undefined;
      }

      if (wasConnected.current) {
        onReconnectRef.current?.();
      }
      wasConnected.current = true;

      // A prod restart or brief network handoff can leave the user clicking Send
      // during the reconnect window. Preserve those chat frames and flush them once
      // the authoritative socket is open instead of rendering a persistent failure.
      const queuedFrames = pendingChatFrames.current.splice(0);
      for (const frame of queuedFrames) {
        ws.send(JSON.stringify(frame));
      }

      // Start ping interval (15s for mobile stability)
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 15000);
      ws.addEventListener('close', () => clearInterval(pingInterval), { once: true });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pong') return;
        onMessageRef.current(data);
      } catch (err) { console.warn('[ws] onmessage parse failed:', err); }
    };

    ws.onclose = () => {
      // A stale socket may close after a newer connection has already replaced it.
      // It must not flip the shared state to disconnected or schedule another socket.
      if (wsRef.current !== ws) return;
      setConnected(false);
      if (wasConnected.current) {
        // Silently reconnect — mobile backgrounding causes frequent disconnects.
        // Reconnect logic handles recovery; toasts are noisy and cause false alarm.
      }

      // Start safety timer if streaming — keep a generous mobile runway before force reset
      const { isStreaming } = useChatStore.getState();
      if (isStreaming && !safetyTimer.current) {
        safetyTimerFired.current = false;
        safetyTimer.current = setTimeout(() => {
          safetyTimer.current = undefined;
          safetyTimerFired.current = true;
          const store = useChatStore.getState();
          if (store.isStreaming) {
            // Keep this silent: mobile disconnects are often recoverable through
            // the DB-sync loop in useChatRuntime, and visible toasts create false alarms.
            store.setStreaming(false);
          }
        }, STREAMING_SAFETY_TIMEOUT);
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 30s max
      reconnectTimer.current = setTimeout(connect, reconnectDelay.current);
      reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
    };

    ws.onerror = () => {
      if (wsRef.current === ws) ws.close();
    };
  }, [url]);

  useEffect(() => {
    connect();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const ws = wsRef.current;
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          // WS가 끊겼으면 즉시 재연결 (backoff 리셋 후)
          reconnectDelay.current = 2000;
          clearTimeout(reconnectTimer.current);
          connect();
          // connect() may take a moment, but the page can still resync via HTTP
          // or a reconnect command once the socket opens. This closes the mobile
          // app-switch gap where a stream finishes while the tab was backgrounded.
          onReconnectRef.current?.();
        } else if (ws.readyState === WebSocket.OPEN) {
          // Always resync immediately on foreground. Waiting for a pong can miss
          // the repaint window on iOS and leaves the chat body stale until the
          // user taps the page. The zombie ping below still verifies liveness.
          onReconnectRef.current?.();

          // iOS 등에서 WS가 zombie(OPEN이지만 실제 dead) 상태일 수 있음.
          // 핑을 보내고, 짧은 시간 안에 pong이 없으면 강제 재연결.

          // 이전 zombie 검사가 진행 중이면 취소 (빠른 앱 전환 시 중첩 방지)
          zombieCheckAbort.current?.abort();
          const abortCtrl = new AbortController();
          zombieCheckAbort.current = abortCtrl;

          let ponged = false;
          const origOnMessage = ws.onmessage;
          const zombieTimer = setTimeout(() => {
            if (abortCtrl.signal.aborted) return;
            if (!ponged && wsRef.current?.readyState === WebSocket.OPEN) {
              // pong 응답 없음 → zombie 상태, 강제 종료 후 재연결
              wsRef.current.close();
            }
          }, ZOMBIE_CHECK_TIMEOUT);

          const pongGuard = (event: MessageEvent) => {
            if (abortCtrl.signal.aborted) {
              // 이 검사는 취소됨 — 원래 핸들러로 복원하고 메시지 전달
              ws.onmessage = origOnMessage;
              origOnMessage?.call(ws, event);
              return;
            }
            try {
              const data = JSON.parse(event.data);
              // pong이든 스트리밍 토큰이든 어떤 메시지든 → 연결이 살아있다는 증거
              if (!ponged) {
                ponged = true;
                clearTimeout(zombieTimer);
                ws.onmessage = origOnMessage;
              }
              if (data.type === 'pong') return; // pong은 앱으로 전달 불필요
            } catch { /* ignore */ }
            origOnMessage?.call(ws, event);
          };
          ws.onmessage = pongGuard;
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearTimeout(reconnectTimer.current);
      clearTimeout(safetyTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((data: any): WebSocketSendResult => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return 'sent';
    }
    if (data?.type === 'chat' && pendingChatFrames.current.length < PENDING_CHAT_FRAME_MAX) {
      pendingChatFrames.current.push(data);
      connect();
      return 'queued';
    }
    if (data?.type === 'chat') {
      console.warn('[ws] send rejected because the reconnect queue is full', {
        readyState: wsRef.current?.readyState,
        sessionId: data.sessionId,
      });
      useChatStore.getState().setStreaming(false);
      useChatStore.getState().setTurnStartTime(null);
      if (data.sessionId) markSessionRunIdle(data.sessionId, { pendingMessageCount: 0 });
    }
    return false;
  }, [connect]);

  return { send, connected, ws: wsRef, safetyTimerFired };
}
