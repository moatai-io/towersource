import { towerHttpUrl, readBrowserAuthToken } from '../features/client-connection/connection';
import i18n from '../i18n';

type VapidResponse = { configured: boolean; publicKey: string | null };


function getToken() {
  return readBrowserAuthToken() || '';
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
  const res = await fetch(towerHttpUrl(`/api/push/vapid-public-key`), { headers: authHeaders() });
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
  if (!isPushSupported()) throw new Error(i18n.t('pushNotification.unsupported', { ns: 'common' }));

  // iOS requires permission to be requested directly from the user's gesture,
  // before a network round-trip can consume transient activation.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(i18n.t('pushNotification.permissionDenied', { ns: 'common' }));

  const vapid = await getVapidInfo();
  if (!vapid.configured || !vapid.publicKey) throw new Error(i18n.t('pushNotification.serverKeyMissing', { ns: 'common' }));

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
  const res = await fetch(towerHttpUrl(`/api/push/subscribe`), {
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
  await fetch(towerHttpUrl(`/api/push/subscribe`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}

export async function sendTestPush(): Promise<{ sent: number; failed: number }> {
  const res = await fetch(towerHttpUrl(`/api/push/test`), { method: 'POST', headers: authHeaders() });
  if (!res.ok) throw new Error(`test push failed (${res.status})`);
  return res.json();
}

/** Local registration only; provider acceptance and server delivery require a test push. */
export async function hasLocalPushSubscription(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return !!(await registration?.pushManager.getSubscription());
}
