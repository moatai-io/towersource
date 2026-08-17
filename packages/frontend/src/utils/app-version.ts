export const RELOAD_ONCE_KEY = 'tower:reload-once';
export const RELOAD_REASON_KEY = 'tower:reload-reason';

const RELOAD_GUARD_TTL_MS = 60_000;

interface ReloadOnceOptions {
  /** Delete app-shell JS caches before reloading. Used for stale lazy chunks. */
  clearJsCaches?: boolean;
  /** Add a one-off query param so the navigation cannot reuse a stale document. */
  cacheBust?: boolean;
}

export function normalizeVersion(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error
    ? `${error.name} ${error.message}`
    : typeof error === 'string'
      ? error
      : '';

  if (!message) return false;

  return [
    'Failed to fetch dynamically imported module',
    'Importing a module script failed',
    'not a valid JavaScript MIME type',
    'Expected a JavaScript-or-Wasm module script',
    'Loading chunk',
    'ChunkLoadError',
    'dynamically imported module',
  ].some((needle) => message.includes(needle));
}

function hasRecentReloadGuard(): boolean {
  const raw = sessionStorage.getItem(RELOAD_ONCE_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  // Backward compatibility with the old boolean marker ('1'). Treat it as
  // recent so already-open tabs do not enter a reload loop after upgrade.
  if (!Number.isFinite(ts) || ts <= 1) return true;
  return Date.now() - ts < RELOAD_GUARD_TTL_MS;
}

async function clearAppJsCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const keys = await caches.keys();
  await Promise.all(keys
    .filter((key) => key.includes('js-runtime-cache') || key.startsWith('workbox-precache'))
    .map((key) => caches.delete(key)));
}

function navigateReload(cacheBust?: boolean): void {
  if (!cacheBust) {
    window.location.reload();
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set('__tower_reload', String(Date.now()));
  window.location.replace(url.toString());
}

export function reloadOnce(reason: string, options: ReloadOnceOptions = {}): boolean {
  try {
    if (hasRecentReloadGuard()) return false;
    sessionStorage.setItem(RELOAD_ONCE_KEY, String(Date.now()));
    sessionStorage.setItem(RELOAD_REASON_KEY, reason);

    if (options.clearJsCaches) {
      void clearAppJsCaches()
        .catch(() => undefined)
        .finally(() => navigateReload(options.cacheBust));
      return true;
    }

    navigateReload(options.cacheBust);
    return true;
  } catch {
    navigateReload(options.cacheBust);
    return true;
  }
}

export function recoverFromChunkLoadError(): boolean {
  return reloadOnce('chunk-load-error', { clearJsCaches: true, cacheBust: true });
}

export function clearReloadOnceFlag() {
  try {
    const raw = sessionStorage.getItem(RELOAD_ONCE_KEY);
    const ts = Number(raw);
    // Keep the guard alive briefly after reload. If the same stale bundle throws
    // again immediately, this prevents a mobile/PWA reload loop and leaves the
    // error visible for diagnosis instead.
    if (raw && Number.isFinite(ts) && Date.now() - ts < RELOAD_GUARD_TTL_MS) return;
    sessionStorage.removeItem(RELOAD_ONCE_KEY);
    sessionStorage.removeItem(RELOAD_REASON_KEY);
  } catch {
    // ignore
  }
}
