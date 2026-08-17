import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './i18n'; // i18n initialization — must be imported before App
import './index.css';
import { DialogProvider } from './hooks/useDialog';

const App = React.lazy(() => import('./App'));
const SharedViewer = React.lazy(() => import('./components/shared/SharedViewer').then((module) => ({ default: module.SharedViewer })));
const FileViewerPage = React.lazy(() => import('./components/files/FileViewerPage').then((module) => ({ default: module.FileViewerPage })));
const ShortFileLinkRedirect = React.lazy(() => import('./components/files/ShortFileLinkRedirect').then((module) => ({ default: module.ShortFileLinkRedirect })));
const MeetingRecorderPage = React.lazy(() => import('./components/meeting/MeetingRecorderPage').then((module) => ({ default: module.MeetingRecorderPage })));
const PublicAIServiceChat = React.lazy(() => import('./features/ai-services/PublicAIServiceChat').then((module) => ({ default: module.PublicAIServiceChat })));
const VoiceLabPage = React.lazy(() => import('./features/voice-lab/VoiceLabPage').then((module) => ({ default: module.VoiceLabPage })));

async function resetStaleDevServiceWorker(): Promise<void> {
  if (!['desk-dev.tower.example.com', 'app.localhost'].includes(window.location.hostname)) return;
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

// Phase 1.1 of URL routing formalization (issue #11):
// Route splitting moved here so /file-viewer and /shared/:token don't have to
// render the full App shell. Everything else falls through to App (which still
// owns the in-app deep-link `/s/:sessionId` handler — that will be migrated to
// react-router proper in Phase 1.2). Decision doc:
// workspace/decisions/2026-05-23-url-routing-phase-1.md
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DialogProvider>
      <BrowserRouter>
        <React.Suspense fallback={null}>
          <Routes>
            <Route path="/file-viewer" element={<FileViewerPage />} />
            <Route path="/f/:shortId" element={<ShortFileLinkRedirect />} />
            <Route path="/meeting-recorder" element={<MeetingRecorderPage />} />
            <Route path="/voice-lab" element={<VoiceLabPage />} />
            <Route path="/ai/:channelId" element={<PublicAIServiceChat />} />
            <Route path="/ai-service-chat/:channelId" element={<PublicAIServiceChat />} />
            <Route path="/shared/:token" element={<SharedViewer />} />
            <Route path="*" element={<App />} />
          </Routes>
        </React.Suspense>
      </BrowserRouter>
    </DialogProvider>
  </React.StrictMode>
);

// Sentinel for the dead-man reload timer in index.html.
// If this attribute isn't set within 7s of page load, the inline script in
// index.html assumes the JS heap was reclaimed by the OS (iOS Chrome's
// long-idle tab behaviour) and force-reloads. Setting it here means: the JS
// bundle parsed, the modules imported, and ReactDOM.createRoot() returned —
// good enough proxy for "the tab is alive."
document.documentElement.setAttribute('data-app-mounted', '1');

// Mobile virtual-keyboard tracking via visualViewport.
// iOS Safari/Chrome don't honour the `interactive-widget=resizes-content`
// viewport meta hint (Chrome desktop only), so on focus the keyboard slides
// up *over* the layout viewport and the InputBox at the bottom is hidden.
// We mirror visualViewport.height into a CSS variable (--vvh) so the root
// layout can shrink to the actual visible area on mobile — InputBox then
// naturally rides above the keyboard.
(function setupVisualViewportTracking() {
  const vv = (window as any).visualViewport as VisualViewport | undefined;
  if (!vv) return; // older browsers — skip, fallback to 100vh
  const root = document.documentElement;
  const readVvh = () => {
    // iOS reports the visual viewport as a floating point value and can briefly
    // expose stale layoutViewport dimensions while the URL bar / keyboard is
    // animating. Clamp to the smaller available height so the React app shell
    // never keeps a 100dvh bottom edge hidden behind the keyboard.
    const h = Math.min(vv.height || window.innerHeight, window.innerHeight || vv.height);
    return `${Math.max(1, Math.floor(h))}px`;
  };
  const update = () => {
    root.style.setProperty('--vvh', readVvh());
  };
  update();
  window.addEventListener('resize', update);
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);

  // iOS Safari/Chrome quirk: during the keyboard slide-up animation (~250-400ms)
  // the `resize` event fires only sparsely, so --vvh stays stale and the
  // bottom-anchored InputBox briefly hides behind the keyboard. Users then
  // need to type one character to trigger a reflow that picks up the latest
  // vvh value ("타이핑 창이 사라져, 한 글자 쳐야 원위치").
  //
  // Fix: when a text input/textarea gains focus, run a short rAF loop that
  // re-reads vv.height every frame for ~450ms — enough to cover the keyboard
  // animation on iOS without any continuous cost outside of focus.
  let focusRafId: number | null = null;
  window.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const tag = t.tagName;
    const editable = tag === 'TEXTAREA' || tag === 'INPUT' || t.isContentEditable;
    if (!editable) return;
    root.classList.add('tower-input-focused');
    const start = performance.now();
    const tick = () => {
      update();
      if (performance.now() - start < 450) {
        focusRafId = requestAnimationFrame(tick);
      } else {
        focusRafId = null;
      }
    };
    if (focusRafId !== null) cancelAnimationFrame(focusRafId);
    focusRafId = requestAnimationFrame(tick);
  });
  let focusOutTimer: number | null = null;
  window.addEventListener('focusout', () => {
    if (focusOutTimer !== null) window.clearTimeout(focusOutTimer);
    focusOutTimer = window.setTimeout(() => {
      focusOutTimer = null;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      const stillEditable = !!active && (tag === 'TEXTAREA' || tag === 'INPUT' || active.isContentEditable);
      if (!stillEditable) root.classList.remove('tower-input-focused');
      if (focusRafId !== null) {
        cancelAnimationFrame(focusRafId);
        focusRafId = null;
      }
      // One final update so the layout snaps back when the keyboard slides down.
      requestAnimationFrame(update);
    }, 240);
  });
})();
