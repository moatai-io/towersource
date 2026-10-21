import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeRemoteGws } from '../execution/worker/worker-server.js';
import { AGENT_GWS_MIGRATION_ERROR } from './agent-gws-credential-selection.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

async function bundle(files: Record<string, string>) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-gws-synthetic-'));
  const source = path.join(root, 'source');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(source, 'gws', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: 0o600 });
  }
  return { TOWER_REMOTE_GWS_CONFIG_B64: execFileSync('tar', ['-czf', '-', '-C', source, 'gws']).toString('base64') };
}

const synthetic = JSON.stringify({ type: 'authorized_user', refresh_token: 'synthetic-agent-account' });

describe('Worker Agent GWS account selection', () => {
  it.each([
    ['member', '7'], ['operator', '8'], ['admin', '9'], ['invalid legacy requester', '../other'],
  ])('uses the same root Agent account for %s and never creates requester paths', async (_role, userId) => {
    const credentials = await bundle({ 'credentials.json': synthetic, 'token_cache.json': '{}' });
    const run = await materializeRemoteGws(root!, { ...credentials, TOWER_REMOTE_GWS_USER_ID: userId });
    try {
      expect(run.env.XDG_CONFIG_HOME).toBe(path.join(run.env.HOME, '.config'));
      expect(run.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe(run.env.GWS_CONFIG_HOME);
      expect(run.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBe(path.join(run.env.GWS_CONFIG_HOME, 'credentials.json'));
      expect(await fs.readFile(run.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, 'utf8')).toBe(synthetic);
      expect((await fs.stat(run.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE)).mode & 0o777).toBe(0o600);
      await expect(fs.access(path.join(run.env.GWS_CONFIG_HOME, 'users'))).rejects.toThrow();
    } finally { await run.cleanup(); }
    await expect(fs.access(run.env.HOME)).rejects.toThrow();
  });

  it('isolates simultaneous runs of the same Agent account', async () => {
    const credentials = await bundle({ 'credentials.json': synthetic });
    const first = await materializeRemoteGws(root!, credentials);
    const second = await materializeRemoteGws(root!, credentials);
    try {
      expect(first.env.HOME).not.toBe(second.env.HOME);
      await first.cleanup();
      expect(await fs.readFile(second.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, 'utf8')).toBe(synthetic);
    } finally { await first.cleanup(); await second.cleanup(); }
  });

  it.each([
    { 'users/7/credentials.json': synthetic },
    { 'credentials.json': synthetic, 'users/7/credentials.json': synthetic },
    { 'users/7/credentials.json': synthetic, 'users/8/credentials.json': synthetic },
    { 'credentials.json': synthetic, 'accounts/another/credentials.json': synthetic },
    { 'credentials.json': synthetic, 'accounts.json': '{}' },
    { 'credentials.json': synthetic, 'credentials.other.json': '{}' },
    { 'client_secret.json': '{"installed":{}}' },
    { 'token_cache.json': '{}' },
    { 'credentials.json': 'invalid-synthetic-json' },
  ])('fails closed for ambiguous/unmigrated bundle %j and cleans all run files', async files => {
    const credentials = await bundle(files as Record<string, string>);
    await expect(materializeRemoteGws(root!, { ...credentials, TOWER_REMOTE_GWS_USER_ID: '7' })).rejects.toThrow(AGENT_GWS_MIGRATION_ERROR);
    expect(await fs.readdir(path.join(root!, '.tower-run-credentials'))).toEqual([]);
  });

  it('rejects linked credential files without following them', async () => {
    await bundle({ 'other.json': synthetic });
    const source = path.join(root!, 'source');
    await fs.symlink('other.json', path.join(source, 'gws', 'credentials.json'));
    const credentials = { TOWER_REMOTE_GWS_CONFIG_B64: execFileSync('tar', ['-czf', '-', '-C', source, 'gws']).toString('base64') };
    await expect(materializeRemoteGws(root!, credentials)).rejects.toThrow(AGENT_GWS_MIGRATION_ERROR);
    expect(await fs.readdir(path.join(root!, '.tower-run-credentials'))).toEqual([]);
  });

  it('does not supply authentication paths when no bundle is selected', async () => {
    const run = await materializeRemoteGws('/unused', {});
    expect(run.env).toEqual({});
    await run.cleanup();
  });

  it('cleans the run after an invalid archive', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-gws-synthetic-'));
    await expect(materializeRemoteGws(root, { TOWER_REMOTE_GWS_CONFIG_B64: Buffer.from('not an archive').toString('base64') })).rejects.toThrow(AGENT_GWS_MIGRATION_ERROR);
    expect(await fs.readdir(path.join(root, '.tower-run-credentials'))).toEqual([]);
  });
});
