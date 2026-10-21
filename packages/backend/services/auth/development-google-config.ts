import fs from 'node:fs';
import path from 'node:path';

/** Development-only public routing; never copy OAuth secrets into this file. */
export function applyDevelopmentGoogleConfig(root: string, env: NodeJS.ProcessEnv): void {
  // Vitest validates modules from an isolated committed-state snapshot where
  // developer-local routing files are intentionally absent.
  if (env.NODE_ENV === 'test' || env.VITEST === 'true') return;
  if (env.TOWER_DEPLOYMENT_ID !== 'development') return;
  const file = path.join(root, '.env.local');
  if (!fs.existsSync(file)) {
    throw new Error('Development requires .env.local with PUBLIC_URL and GOOGLE_REDIRECT_URI; see INSTALL.md');
  }
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const match = /^(PUBLIC_URL|GOOGLE_REDIRECT_URI)\s*=\s*(.*)$/.exec(text);
    if (!match) continue; // Never load credentials or unrelated Vite settings here.
    if (values[match[1]] !== undefined) throw new Error('Duplicate development public routing setting');
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const publicUrl = (values.PUBLIC_URL || '').replace(/\/$/, '');
  let url: URL;
  try { url = new URL(publicUrl); } catch { throw new Error('Development PUBLIC_URL must be a valid origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== publicUrl || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new Error('Development PUBLIC_URL must be an HTTPS origin or local HTTP loopback origin');
  }
  if (values.GOOGLE_REDIRECT_URI !== `${publicUrl}/api/auth/google/callback`) {
    throw new Error('Development GOOGLE_REDIRECT_URI must exactly match PUBLIC_URL + /api/auth/google/callback');
  }
  env.PUBLIC_URL = publicUrl;
  env.GOOGLE_REDIRECT_URI = values.GOOGLE_REDIRECT_URI;
}
