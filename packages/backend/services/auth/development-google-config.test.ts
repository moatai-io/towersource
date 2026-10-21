import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDevelopmentGoogleConfig } from './development-google-config.js';
const dirs: string[] = [];
function fixture(text?: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'tower-dev-routing-')); dirs.push(root);
  if (text !== undefined) writeFileSync(path.join(root, '.env.local'), text);
  return root;
}
afterEach(() => dirs.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const valid = 'PUBLIC_URL=https://dev.example.com\nGOOGLE_REDIRECT_URI=https://dev.example.com/api/auth/google/callback\n';
describe('development-only Google routing', () => {
  it('skips developer-local routing files in isolated test environments', () => {
    const env = { TOWER_DEPLOYMENT_ID: 'development', NODE_ENV: 'test' };
    expect(() => applyDevelopmentGoogleConfig(fixture(), env)).not.toThrow();
  });
  it('overrides inherited production routing without loading secrets', () => {
    const env = { TOWER_DEPLOYMENT_ID: 'development', PUBLIC_URL: 'https://app.example.com', GOOGLE_CLIENT_SECRET: 'synthetic-original' };
    applyDevelopmentGoogleConfig(fixture(valid + 'GOOGLE_CLIENT_SECRET=synthetic-ignored\n'), env);
    expect(env.PUBLIC_URL).toBe('https://dev.example.com');
    expect(env.GOOGLE_CLIENT_SECRET).toBe('synthetic-original');
  });
  it('never reads development settings in production', () => {
    const env = { PUBLIC_URL: 'https://app.example.com' };
    applyDevelopmentGoogleConfig(fixture('invalid'), env);
    expect(env).toEqual({ PUBLIC_URL: 'https://app.example.com' });
  });
  it('fails closed when development routing is missing', () => {
    expect(() => applyDevelopmentGoogleConfig(fixture(), { TOWER_DEPLOYMENT_ID: 'development' })).toThrow('requires .env.local');
  });
  it.each([
    'PUBLIC_URL=https://dev.example.com\nGOOGLE_REDIRECT_URI=https://app.example.com/api/auth/google/callback',
    'PUBLIC_URL=http://dev.example.com\nGOOGLE_REDIRECT_URI=http://dev.example.com/api/auth/google/callback',
    valid + 'PUBLIC_URL=https://other.example.com',
  ])('rejects invalid or conflicting routing', text => {
    expect(() => applyDevelopmentGoogleConfig(fixture(text), { TOWER_DEPLOYMENT_ID: 'development' })).toThrow();
  });
  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts local development on %s', host => {
    const origin = `http://${host}:32354`;
    const env = { TOWER_DEPLOYMENT_ID: 'development' };
    expect(() => applyDevelopmentGoogleConfig(fixture(`PUBLIC_URL=${origin}\nGOOGLE_REDIRECT_URI=${origin}/api/auth/google/callback`), env)).not.toThrow();
  });
});
