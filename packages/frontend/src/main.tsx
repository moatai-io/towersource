import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { i18nReady } from './i18n';
import './index.css';
import { isAllowedDevHost } from './config/dev-hosts';
import { DialogProvider } from './hooks/useDialog';

import { shouldPreloadApp } from './app-startup-route';

const loadApp = () => import('./App');
// Download App alongside the locale, not after locale initialization and render.
// Reuse the promise so the same chunk is never requested twice.
const appStartup = shouldPreloadApp(window.location.pathname, window.location.search) ? loadApp() : null;
// Keep speculative failures handled; React.lazy still receives the rejection.
void appStartup?.catch(() => {});
const App = React.lazy(() => appStartup ?? loadApp());
const SharedViewer = React.lazy(() => import('./components/shared/SharedViewer').then((module) => ({ default: module.SharedViewer })));
const FileViewerPage = React.lazy(() => import('./components/files/FileViewerPage').then((module) => ({ default: module.FileViewerPage })));
const ShortFileLinkRedirect = React.lazy(() => import('./components/files/ShortFileLinkRedirect').then((module) => ({ default: module.ShortFileLinkRedirect })));
const MeetingRecorderPage = React.lazy(() => import('./components/meeting/MeetingRecorderPage').then((module) => ({ default: module.MeetingRecorderPage })));
const PublicAIServiceChat = React.lazy(() => import('./features/ai-services/PublicAIServiceChat').then((module) => ({ default: module.PublicAIServiceChat })));
const VoiceLabPage = React.lazy(() => import('./features/voice-lab/VoiceLabPage').then((module) => ({ default: module.VoiceLabPage })));
const InvalidLinkPage = React.lazy(() => import('./components/common/InvalidLinkPage').then((module) => ({ default: module.InvalidLinkPage })));
const AccountEmailLinkPage = React.lazy(() => import('./components/auth/AccountEmailLinkPage').then((module) => ({ default: module.AccountEmailLinkPage })));
const PasswordResetLinkPage = React.lazy(() => import('./components/auth/PasswordResetLinkPage').then((module) => ({ default: module.PasswordResetLinkPage })));

function RootPage() {
  const params = new URLSearchParams(window.location.search);
  return params.has('passwordReset') ? <PasswordResetLinkPage />
    : params.has('accountInvitation') || params.has('accountEmailVerification') ? <AccountEmailLinkPage /> : <App />;
}

const APP_SHELL_PATHS = ['/', '/s/:sessionId', '/r/:roomId', '/rooms/:roomId'] as const;

async function resetStaleDevServiceWorker(): Promise<void> {
  if (!isAllowedDevHost(window.location.hostname)) return;
  const marker = 'tower:dev-sw-cleared:v1';
  if (sessionStorage.getItem(marker) === 'done') return;
  let changed = false;
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      changed = registrations.length > 0;
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch {}
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      changed = changed || keys.length > 0;
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {}
  sessionStorage.setItem(marker, 'done');
  if (changed) {
    window.location.reload();
    await new Promise(() => {});
  }
}

async function resetClientStateIfRequested(): Promise<void> {
  if (!new URLSearchParams(window.location.search).has('reset-client')) return;
  try {
    const keep = new Map<string, string>();
    for (const key of ['token', 'username', 'userId', 'tower:authCache', 'tower:lang', 'theme']) {
      const value = localStorage.getItem(key);
      if (value !== null) keep.set(key, value);
    }
    localStorage.clear();
    sessionStorage.clear();
    for (const [key, value] of keep) localStorage.setItem(key, value);
  } catch {}
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {}
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    }
  } catch {}
  const cleanUrl = `${window.location.origin}${window.location.pathname}${window.location.hash}`;
  window.location.replace(cleanUrl);
  await new Promise(() => {});
}

await resetStaleDevServiceWorker();
await resetClientStateIfRequested();

function AppReady({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.setAttribute('data-app-mounted', 'true');
    document.getElementById('tower-boot-status')?.remove();
  }, []);
  return <>{children}</>;
}

// Phase 1.1 of URL routing formalization (issue #11):
// Route splitting moved here so /file-viewer and /shared/:token don't have to
// render the full App shell. Everything else falls through to App (which still
// owns the in-app deep-link `/s/:sessionId` handler — that will be migrated to
// react-router proper in Phase 1.2). Decision doc:
// workspace/decisions/2026-05-23-url-routing-phase-1.md
await i18nReady;
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DialogProvider>
      <BrowserRouter>
        <React.Suspense fallback={null}>
        <AppReady>
          <Routes>
            <Route path="/file-viewer" element={<FileViewerPage />} />
            <Route path="/f/:shortId" element={<ShortFileLinkRedirect />} />
            <Route path="/meeting-recorder" element={<MeetingRecorderPage />} />
            <Route path="/voice-lab" element={<VoiceLabPage />} />
            <Route path="/ai/:channelId" element={<PublicAIServiceChat />} />
            <Route path="/ai-service-chat/:channelId" element={<PublicAIServiceChat />} />
            <Route path="/shared/:token" element={<SharedViewer />} />
            {APP_SHELL_PATHS.map((path) => <Route key={path} path={path} element={<RootPage />} />)}
            <Route path="*" element={<InvalidLinkPage />} />
          </Routes>
        </AppReady>
      </React.Suspense>
      </BrowserRouter>
    </DialogProvider>
  </React.StrictMode>
);

// Focus state is a presentation hook for compact mobile forms. Keyboard viewport
// ownership lives inside the mobile app shell rather than mutating html/body/#root.
(function setupEditableFocusState() {
  const root = document.documentElement;
  const isEditable = (target: EventTarget | null) => {
    const element = target instanceof HTMLElement ? target : null;
    const tag = element?.tagName;
    return !!element && (tag === 'TEXTAREA' || tag === 'INPUT' || element.isContentEditable);
  };

  window.addEventListener('focusin', (event) => {
    if (isEditable(event.target)) root.classList.add('tower-input-focused');
  });
  window.addEventListener('focusout', () => {
    window.requestAnimationFrame(() => {
      if (!isEditable(document.activeElement)) root.classList.remove('tower-input-focused');
    });
  });
})();
