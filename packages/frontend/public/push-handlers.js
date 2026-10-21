/* Tower Web Push handlers. Imported by the generated Workbox service worker. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Tower', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Tower';
  const options = {
    body: data.body || '',
    icon: data.icon || '/pwa-192x192.png',
    badge: data.badge || '/pwa-192x192.png',
    tag: data.tag || data.notificationId || 'tower-notification',
    renotify: !!data.renotify,
    requireInteraction: !!data.requireInteraction,
    actions: data.actionUrl ? [{ action: 'open-session', title: 'Tower ↗' }] : [],
    data: {
      url: data.actionUrl || '/',
      notificationId: data.notificationId || null,
      type: data.type || null,
    },
  };

  event.waitUntil((async () => {
    // Only suppress on this device when the exact session is visibly focused.
    // A hidden tab, another session, or another device must still receive push.
    if (data.type === 'session.completed' && data.actionUrl) {
      const target = new URL(data.actionUrl, self.location.origin);
      const sessionKey = target.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
      if (sessionKey && target.origin === self.location.origin) {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (windows.some((client) => {
          const current = new URL(client.url);
          return client.focused && client.visibilityState === 'visible'
            && !current.searchParams.has('view') && !current.searchParams.has('system')
            && current.origin === target.origin && current.pathname === target.pathname;
        })) return;
      }
    }
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  const target = new URL(url, self.location.origin);
  if (target.origin !== self.location.origin) return;
  const targetUrl = target.href;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sessionKey = target.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
    for (const client of clientList) {
      if ('focus' in client) {
        if (sessionKey && client.type === 'window' && new URL(client.url).origin === target.origin) {
          client.postMessage({ type: 'tower-open-session', sessionKey });
          return client.focus();
        }
        try {
          await client.navigate(targetUrl);
        } catch {}
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});
