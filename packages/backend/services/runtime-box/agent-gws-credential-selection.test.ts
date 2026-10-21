import { describe, expect, it } from 'vitest';
import { selectAgentGwsCredentialRelativePath } from './agent-gws-credential-selection.js';

describe('Agent GWS inventory policy for local/remote adapters', () => {
  it('selects the root credential, independent of any requester', () => {
    expect(selectAgentGwsCredentialRelativePath(['credentials.json', 'client_secret.json', 'token_cache.json'])).toBe('credentials.json');
  });
  it.each([
    [], ['client_secret.json'], ['token_cache.json'], ['users/7/credentials.json'],
    ['credentials.json', 'users/7/token_cache.json'],
    ['credentials.json', 'accounts/team.json'],
    ['credentials.json', 'accounts.json'],
    ['credentials.json', 'credentials.enc'],
    ['credentials.json', 'nested/credentials.json'],
  ].map(entries => ({ entries })))('requires consented migration rather than selecting $entries', ({ entries }) => {
    expect(() => selectAgentGwsCredentialRelativePath(entries)).toThrow('AGENT_GWS_ACCOUNT_MIGRATION_REQUIRED');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { decodeAgentGwsBundle, materializeAgentGwsBundle } from './agent-gws-credential-selection.js';

// Generate exact synthetic tar headers so GNU tar cannot normalize unsafe test paths.
function bundle(entries: Array<{ name: string; type?: string; content?: string; link?: string }>): string {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '{}');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write('0000600\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])).toString('base64');
}

const rootCredential = { name: 'gws/credentials.json', content: '{"type":"authorized_user","refresh_token":"synthetic-agent"}' };

describe('bounded Agent GWS archive decoding shared by local, Host and Worker', () => {
  it('materializes only the portable root credential and drops OAuth/cache sidecars', () => {
    const files = decodeAgentGwsBundle(bundle([rootCredential, { name: 'gws/client_secret.json' }, { name: 'gws/token_cache.json' }, { name: 'gws/unrelated.txt' }]));
    expect(files.map(file => file.name)).toEqual(['credentials.json']);
    expect(files[0].content.toString()).toBe(rootCredential.content);
  });

  it('preserves a service-account credential without applying OAuth transforms', () => {
    const serviceAccount = JSON.stringify({ type: 'service_account', client_email: 'agent@example.invalid', private_key: 'synthetic' });
    const files = decodeAgentGwsBundle(bundle([{ name: 'gws/credentials.json', content: serviceAccount }, { name: 'gws/token_cache.json' }]));
    expect(files.map(file => file.name)).toEqual(['credentials.json']);
    expect(files[0].content.toString()).toBe(serviceAccount);
  });

  it.each([
    { name: '../escaped.json' },
    { name: '/tmp/escaped.json' },
    { name: 'gws/../../escaped.json' },
    { name: 'gws/../escaped.json' },
    { name: 'gws//credentials.json' },
    { name: 'gws/./credentials.json' },
    { name: 'gws\\credentials.json' },
    { name: 'other/credentials.json' },
    { name: 'gws/credentials.json' }, // duplicate
    { name: 'gws/link', type: '2', link: '../../escaped.json' },
    { name: 'gws/hardlink', type: '1', link: '/tmp/escaped.json' },
    { name: 'gws/device', type: '3' },
    { name: 'gws/PaxHeader', type: 'x', content: '30 path=../../escaped.json\n' },
    { name: 'gws/LongName', type: 'L', content: '../../escaped.json\0' },
    { name: 'gws/users/7/credentials.json' },
    { name: 'gws/accounts.json' },
  ])('rejects unsafe/ambiguous archive entry $name type=$type before writing', async entry => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-agent-gws-archive-'));
    try {
      await expect(materializeAgentGwsBundle(bundle([rootCredential, entry]), root)).rejects.toThrow('AGENT_GWS_ACCOUNT_MIGRATION_REQUIRED');
      expect(await fs.readdir(root)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('rejects malformed, truncated, and oversized archive input with a value-free error', () => {
    for (const encoded of [Buffer.from('synthetic-sensitive-invalid').toString('base64'), gzipSync(Buffer.alloc(513, 1)).toString('base64'), gzipSync(Buffer.alloc(5 * 1024 * 1024)).toString('base64')]) {
      expect(() => decodeAgentGwsBundle(encoded)).toThrow('AGENT_GWS_ACCOUNT_MIGRATION_REQUIRED');
      try { decodeAgentGwsBundle(encoded); } catch (error) { expect(String(error)).not.toContain('synthetic-sensitive-invalid'); }
    }
  });
});

import { createHash } from 'node:crypto';
import { normalizeApprovedLegacyGwsBundle } from './agent-gws-credential-selection.js';
const legacyCredential = JSON.stringify({ type: 'authorized_user', client_id: 'synthetic-client', client_secret: 'synthetic-secret', refresh_token: 'synthetic-refresh' });
const pin = (encoded: string, credentialPath = 'users/7/credentials.json') => ({ bundleSha256: createHash('sha256').update(encoded).digest('hex'), credentialPath });
describe('approved legacy GWS runtime normalization', () => {
  it('preserves selected bytes and discards other accounts and caches', () => {
    const input = bundle([{ name: 'gws/users/7/credentials.json', content: legacyCredential }, { name: 'gws/users/8/credentials.json' }, { name: 'gws/token_cache.json' }]);
    const output = normalizeApprovedLegacyGwsBundle(input, pin(input));
    const files = decodeAgentGwsBundle(output);
    expect(files.map(f => f.name)).toEqual(['credentials.json']);
    expect(files[0].content.toString()).toBe(legacyCredential);
    expect(() => decodeAgentGwsBundle(input)).toThrow();
  });
  it('materializes the transformed bundle with the existing consumer and 0600', async () => {
    const input = bundle([{ name: 'gws/users/7/credentials.json', content: legacyCredential }]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gws-legacy-consumer-'));
    try {
      const file = await materializeAgentGwsBundle(normalizeApprovedLegacyGwsBundle(input, pin(input)), root);
      expect(await fs.readFile(file, 'utf8')).toBe(legacyCredential);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(['users/8/credentials.json', '../credentials.json', 'token_cache.json'])('rejects missing or invalid approved path %s', credentialPath => {
    const input = bundle([{ name: 'gws/users/7/credentials.json', content: legacyCredential }]);
    expect(() => normalizeApprovedLegacyGwsBundle(input, pin(input, credentialPath))).toThrow('AGENT_GWS_ACCOUNT_MIGRATION_REQUIRED');
  });
  it('rejects archive changes after approval', () => {
    const input = bundle([{ name: 'gws/users/7/credentials.json', content: legacyCredential }]);
    expect(() => normalizeApprovedLegacyGwsBundle(input, { ...pin(input), bundleSha256: '0'.repeat(64) })).toThrow();
  });
  it.each(['{}', 'null', '{', JSON.stringify({ type: 'service_account' })])('rejects unusable credential without leaking content', content => {
    const input = bundle([{ name: 'gws/users/7/credentials.json', content }]);
    expect(() => normalizeApprovedLegacyGwsBundle(input, pin(input))).toThrow('AGENT_GWS_ACCOUNT_MIGRATION_REQUIRED');
  });
  it('keeps archive link guards even with a matching approval hash', () => {
    const input = bundle([{ name: 'gws/users/7/credentials.json', content: legacyCredential }, { name: 'gws/link', type: '2' }]);
    expect(() => normalizeApprovedLegacyGwsBundle(input, pin(input))).toThrow();
  });
});
