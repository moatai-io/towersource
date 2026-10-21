import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readManagedMcpManifest, mutateMcpManifest, assertMcpServerName } from './project-mcp-manifest.js';
describe('MCP manifest write boundary', () => {
  it('serializes concurrent changes while preserving unknown fields', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manifest-test-'));
    try {
      await fs.mkdir(path.join(root, '.tower/mcp'), { recursive: true });
      await fs.writeFile(path.join(root, '.tower/mcp/manifest.json'), JSON.stringify({ version: 1, custom: 'keep', servers: [] }));
      await Promise.all(['one', 'two'].map(name => mutateMcpManifest(root, servers => [...servers, { name, type: 'streamable-http', url: 'https://example.com/mcp' }])));
      const value = await readManagedMcpManifest(root);
      expect(value.custom).toBe('keep'); expect(value.servers.map(s => s.name).sort()).toEqual(['one', 'two']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('refuses symlinked manifest descendants', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manifest-test-'));
    try {
      await fs.symlink(os.tmpdir(), path.join(root, '.tower'));
      await expect(readManagedMcpManifest(root)).rejects.toThrow('Unsafe MCP manifest directory');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('preserves malformed input rather than overwriting it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manifest-test-'));
    try {
      await fs.mkdir(path.join(root, '.tower/mcp'), { recursive: true });
      const file = path.join(root, '.tower/mcp/manifest.json'); await fs.writeFile(file, '{broken');
      await expect(mutateMcpManifest(root, () => [])).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe('{broken');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(['UPPER', '../outside', 'space name', 'x.y', '', '_prefix'])('rejects incompatible server name %s', name => { expect(() => assertMcpServerName(name)).toThrow(); });
});
