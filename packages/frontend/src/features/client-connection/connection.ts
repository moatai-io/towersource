/** Connection boundary shared by web and future packaged clients.
 * Paths are Tower-owned root-relative paths, never arbitrary external URLs.
 * This is build-time configuration, not a runtime server/account switcher.
 */
export function normalizeServerBase(value: string): string {
  if (!value) return '';
  // URL parsing silently trims whitespace and rewrites backslashes; reject before parsing.
  if (!/^https?:\/\//i.test(value) || /[\\\s]/.test(value)) {
    throw new Error('Tower server must be an explicit HTTP(S) URL without whitespace or backslashes');
  }
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Tower server must be an HTTP(S) URL without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function validatePath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(path)) {
    throw new Error('Tower path must be root-relative');
  }
  const pathname = path.split(/[?#]/, 1)[0];
  if (pathname.split('/').some(segment => /^(\.|%2e){1,2}$/i.test(segment))) {
    throw new Error('Tower path must not traverse directories');
  }
}

export function createClientConnection(serverBase: string, browserOrigin: string) {
  const base = normalizeServerBase(serverBase);
  return {
    httpUrl(path: string): string {
      validatePath(path);
      return `${base}${path}`;
    },
    webSocketUrl(path: string): string {
      validatePath(path);
      const url = new URL(`${base || normalizeServerBase(browserOrigin)}${path}`);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.href;
    },
  };
}

function currentConnection() {
  return createClientConnection(import.meta.env.VITE_API_URL || '', window.location.origin);
}

/** Also used for authenticated Tower download/preview paths; external links stay untouched by callers. */
export function towerHttpUrl(path: string): string {
  // HTTP URL construction does not require a browser (e.g. store unit tests).
  return createClientConnection(import.meta.env.VITE_API_URL || '', '').httpUrl(path);
}

export function towerWebSocketUrl(path: string): string {
  return currentConnection().webSocketUrl(path);
}

/** Browser implementation only. Native secure storage and all token writers remain a later migration. */
export function readBrowserAuthToken(): string | null {
  return localStorage.getItem('token');
}
