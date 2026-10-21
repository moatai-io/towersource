import { towerHttpUrl, readBrowserAuthToken } from '../../features/client-connection/connection';
import React, { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRoomStore } from '../../stores/room-store';
import { useSessionStore, type SessionMeta } from '../../stores/session-store';


function getToken() {
  return readBrowserAuthToken() || '';
}

function notificationAge(dateStr: string): { unit: 'now' | 'minute' | 'hour' | 'day'; count: number } {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return { unit: 'now', count: 0 };
  if (minutes < 60) return { unit: 'minute', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hour', count: hours };
  return { unit: 'day', count: Math.floor(hours / 24) };
}

const NOTIF_ICONS: Record<string, string> = {
  task_done: '✅',
  task_failed: '❌',
  mention: '@',
  room_invite: '📨',
  system: '⚙️',
  session_done: '✅',
  proactive: '💬',
  'task.completed': '✅',
  'task.failed': '❌',
  'message.mention': '@',
  'message.room': '💬',
  'session.completed': '✅',
  'spawn.completed': '🧩',
  'automation.completed': '✅',
  'automation.failed': '❌',
  'proactive.message': '💬',
  'system.announcement': '⚙️',
};

interface NotificationBellProps {
  onSelectSession?: (session: SessionMeta) => void;
}

export function NotificationBell({ onSelectSession }: NotificationBellProps) {
  const { t } = useTranslation('layout');
  const [open, setOpen] = React.useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const notifications = useRoomStore((s) => s.notifications);
  const unreadCount = useRoomStore((s) => s.unreadNotifCount);
  const setNotifications = useRoomStore((s) => s.setNotifications);
  const setUnreadNotifCount = useRoomStore((s) => s.setUnreadNotifCount);
  const markAllRead = useRoomStore((s) => s.markAllNotificationsRead);

  // Fetch notifications on mount
  useEffect(() => {
    fetch(towerHttpUrl(`/api/notifications`), {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.notifications) setNotifications(data.notifications);
        if (data.unreadCount !== undefined) setUnreadNotifCount(data.unreadCount);
      })
      .catch(() => {});
  }, [setNotifications, setUnreadNotifCount]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleMarkAllRead = useCallback(() => {
    markAllRead();
    fetch(towerHttpUrl(`/api/notifications/read-all`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
    }).catch(() => {});
  }, [markAllRead]);

  const handleMarkOne = useCallback((notifId: string) => {
    const roomStore = useRoomStore.getState();
    const notification = roomStore.notifications.find((item) => item.id === notifId);
    roomStore.markNotificationRead(notifId);
    const sessionId = notification && (notification.metadata?.sessionId || notification.sessionId);
    if (typeof sessionId === 'string' && sessionId) {
      useSessionStore.getState().markSessionRead(sessionId);
    }
    fetch(towerHttpUrl(`/api/notifications/${notifId}/read`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
    }).catch(() => {});
  }, []);

  const openActionUrl = useCallback((actionUrl: string) => {
    let nextUrl = actionUrl;
    try {
      const parsed = new URL(actionUrl, window.location.origin);
      if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/rooms/')) {
        parsed.pathname = parsed.pathname.replace(/^\/rooms\//, '/r/');
        nextUrl = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {}
    window.history.pushState({}, '', nextUrl);
    window.dispatchEvent(new PopStateEvent('popstate'));
    if (window.location.hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`p-2 rounded-lg transition-all relative ${
          open
            ? 'bg-surface-800 text-gray-200'
            : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'
        }`}
        title={t('notifications')}
        aria-label={t('notifications')}
      >
        {/* Bell icon */}
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {/* Badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center bg-red-500 text-white text-[12px] font-bold rounded-full px-1 shadow-lg shadow-red-500/30">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 md:w-96 max-h-[70vh] bg-surface-900 border border-surface-700 rounded-xl shadow-2xl shadow-black/40 overflow-hidden z-[100] flex flex-col">
          {/* Header */}
          <div className="px-3 py-2 border-b border-surface-800 flex items-center justify-between">
            <span className="text-[14px] font-semibold text-gray-300">{t('notifications')}</span>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-[13px] text-primary-400 hover:text-primary-300 transition-colors"
              >
                {t('markAllNotificationsRead')}
              </button>
            )}
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 text-[15px]">
                {t('noNotificationsYet')}
              </div>
            ) : (
              notifications.slice(0, 50).map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    if (!n.read) handleMarkOne(n.id);
                    if (n.actionUrl) {
                      openActionUrl(n.actionUrl);
                      setOpen(false);
                      return;
                    }
                    // Proactive notifications → go to Inbox (card with preview)
                    if ((n.type === 'proactive' || n.type === 'proactive.message') && (n.metadata?.sessionId || n.sessionId)) {
                      const sessionId = (n.metadata.sessionId || n.sessionId) as string;
                      // Ensure session is in store (proactive sessions may not be loaded yet)
                      const store = useSessionStore.getState();
                      if (!store.sessions.find((s) => s.id === sessionId)) {
                        fetch(towerHttpUrl(`/api/sessions/${sessionId}`), {
                          headers: { Authorization: `Bearer ${getToken()}` },
                        })
                          .then((r) => r.json())
                          .then((data) => { if (data?.id) useSessionStore.getState().addSession(data); })
                          .catch(() => {});
                      }
                      useSessionStore.getState().setActiveView('inbox');
                      setOpen(false);
                    }
                    // session_done → go directly to session
                    else if ((n.type === 'session_done' || n.type === 'session.completed' || n.type === 'spawn.completed') && (n.metadata?.sessionId || n.sessionId)) {
                      const sessionId = (n.metadata.sessionId || n.sessionId) as string;
                      const store = useSessionStore.getState();
                      const session = store.sessions.find((s) => s.id === sessionId);
                      if (session) {
                        store.markSessionRead(sessionId);
                        store.setActiveView('chat');
                        store.setSidebarTab('sessions');
                        if (onSelectSession) {
                          onSelectSession(session);
                        } else {
                          store.setActiveSessionId(sessionId);
                        }
                        setOpen(false);
                      }
                    }
                  }}
                  className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors border-b border-surface-800/50 ${
                    n.read
                      ? 'opacity-50 hover:opacity-70'
                      : 'hover:bg-surface-800/50'
                  }`}
                >
                  {/* Icon */}
                  <span className="text-[16px] mt-0.5 shrink-0">
                    {NOTIF_ICONS[n.type] || '🔔'}
                  </span>
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium text-gray-200 truncate">
                      {n.title}
                    </div>
                    {n.body && (
                      <div className="text-[13px] text-gray-400 mt-0.5 line-clamp-2">
                        {n.body}
                      </div>
                    )}
                    <div className="text-[12px] text-gray-500 mt-1">
                      {(() => {
                        const age = notificationAge(n.createdAt);
                        if (age.unit === 'now') return t('notificationJustNow');
                        return t(`notificationAge.${age.unit}`, { count: age.count });
                      })()}
                    </div>
                  </div>
                  {/* Unread dot */}
                  {!n.read && (
                    <div className="w-2 h-2 rounded-full bg-primary-400 mt-1.5 shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
