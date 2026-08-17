type VapidResponse = { configured: boolean; publicKey: string | null };

const API = import.meta.env.VITE_API_URL || '';

function getToken() {
  return localStorage.getItem('token') || '';
}

function authHeaders() {
  return { Authorization: `Bearer ${getToken()}` };
}

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray.buffer.slice(outputArray.byteOffset, outputArray.byteOffset + outputArray.byteLength) as ArrayBuffer;
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function getVapidInfo(): Promise<VapidResponse> {
  const res = await fetch(`${API}/api/push/vapid-public-key`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`push config failed (${res.status})`);
  return res.json();
}

function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Mac/i.test(ua)) return 'mac';
  if (/Win/i.test(ua)) return 'windows';
  return 'web';
}

export async function subscribeToWebPush(): Promise<{ ok: true }> {
  if (!isPushSupported()) throw new Error('이 브라우저는 Web Push를 지원하지 않습니다.');

  const vapid = await getVapidInfo();
  if (!vapid.configured || !vapid.publicKey) throw new Error('서버 Web Push 키가 아직 설정되지 않았습니다.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('브라우저 알림 권한이 허용되지 않았습니다.');

  let registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration) {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  }
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(vapid.publicKey),
  });

  const json = subscription.toJSON() as any;
  const res = await fetch(`${API}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      userAgent: navigator.userAgent,
      deviceLabel: `${detectPlatform()} browser`,
      platform: detectPlatform(),
    }),
  });
  if (!res.ok) throw new Error(`push subscribe failed (${res.status})`);
  return { ok: true };
}

export async function unsubscribeFromWebPush(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration) return;

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => {});
  await fetch(`${API}/api/push/subscribe`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}

export async function sendTestPush(): Promise<{ sent: number; failed: number }> {
  const res = await fetch(`${API}/api/push/test`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) throw new Error(`test push failed (${res.status})`);
  return res.json();
}
