import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

function block(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`source block not found: ${start}`);
  return source.slice(from, to);
}

describe('Google OAuth GWS bundle contract', () => {
  it('stores only authorized_user credentials for Agent OAuth Connections', () => {
    const agent = block('async function buildAgentGwsConfigBundle', 'async function savePersonalGwsConfigSecretFromToken');
    expect(agent).toContain("type: 'authorized_user'");
    expect(agent).toContain("path.join(tmpGwsDir, 'credentials.json')");
    expect(agent).not.toContain("path.join(tmpGwsDir, 'client_secret.json')");
    expect(agent).not.toContain("path.join(tmpGwsDir, 'token_cache.json')");
  });

  it('does not synthesize OAuth client or token-cache files for legacy personal bundles', () => {
    const personal = block('async function savePersonalGwsConfigSecretFromToken', 'function parseGwsTowerUserState');
    expect(personal).toContain("type: 'authorized_user'");
    expect(personal).toContain("path.join(tmpUserDir, 'credentials.json')");
    expect(personal).not.toContain("path.join(tmpGwsDir, 'client_secret.json')");
    expect(personal).not.toContain("path.join(tmpUserDir, 'token_cache.json')");
  });
});
