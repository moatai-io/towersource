import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';

let root: string | undefined;
let server: http.Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
  server = undefined;
});

async function fixture() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-worker-upload-http-'));
  const token = 'synthetic-upload-token';
  server = createRemoteWorkbenchWorkerServer({ workerId: 'upload-test', token, projects: { p: root } });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    root,
    baseUrl,
    put: (relative: string, body: string, projectId = 'p', bearer = token) => fetch(
      `${baseUrl}/v1/files/${projectId}/content?path=${encodeURIComponent(relative)}`,
      { method: 'PUT', body, headers: { authorization: `Bearer ${bearer}` } },
    ),
    text: (relative: string, content: string, mode = 'exclusive', expected?: string) => fetch(`${baseUrl}/v1/files/p/content?path=${encodeURIComponent(relative)}&text-mode=${mode}`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(content)),
        ...(expected !== undefined ? { 'x-tower-expected-sha256': createHash('sha256').update(expected).digest('hex') } : {}) }, body: content,
    }),
    head: (relative: string, projectId = 'p', bearer = token) => fetch(`${baseUrl}/v1/files/${projectId}/content?path=${encodeURIComponent(relative)}`, {
      method: 'HEAD', headers: { authorization: `Bearer ${bearer}` },
    }),
    get: (relative: string, range?: string) => fetch(`${baseUrl}/v1/files/p/content?path=${encodeURIComponent(relative)}`, {
      headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) },
    }),
  };
}

describe('Remote Worker upload endpoint permissions', () => {
  it('publishes and downloads a complete file with project creation permissions, not staging 0600', async () => {
    const { root, put, get } = await fixture();
    // Baseline created on the same FS under the same umask/default ACL policy.
    const baseline = path.join(root, 'baseline');
    await fs.writeFile(baseline, '', { mode: 0o664 });
    const response = await put('nested/upload.txt', 'complete-upload');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sizeBytes: 15 });
    const target = path.join(root, 'nested/upload.txt');
    expect((await fs.stat(target)).mode & 0o777).toBe((await fs.stat(baseline)).mode & 0o777);
    expect(await fs.readFile(target, 'utf8')).toBe('complete-upload');
    expect(await (await get('nested/upload.txt')).text()).toBe('complete-upload');
    expect(await fs.readdir(path.dirname(target))).toEqual(['upload.txt']);
  });

  it('stores and conditionally edits large text without the execution JSON limit', async () => {
    const { root, text, head } = await fixture();
    const original = '한글 Markdown\n'.repeat(20000);
    const unsupportedPath = await head('work/large.md');
    expect(unsupportedPath.headers.get('x-tower-text-write')).toBe('v1');
    const saved = await text('work/large.md', original);
    expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ written: true, bytes: Buffer.byteLength(original), textWriteVersion: 1 });
    expect(await fs.readFile(path.join(root, 'work/large.md'), 'utf8')).toBe(original);
    expect((await text('work/large.md','collision')).status).toBe(409);
    const replacement = 'updated\n'.repeat(30000);
    expect((await text('work/large.md',replacement,'cas',original)).status).toBe(200);
    expect((await text('work/large.md','stale','cas',original)).status).toBe(409);
    expect(await fs.readFile(path.join(root, 'work/large.md'), 'utf8')).toBe(replacement);
    expect((await text('../escape.md','escape')).status).toBe(400);
  });

  it('retains the small execution JSON bound while file bodies can be larger', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST', headers: { authorization: 'Bearer synthetic-upload-token', 'content-type': 'application/json' },
      body: JSON.stringify({ oversized: 'x'.repeat(65000) }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('request body too large');
  });

  it('serves metadata without body and bounds a probe for a multi-megabyte PDF', async () => {
    const { root, head, get } = await fixture();
    const bytes = Buffer.alloc(3 * 1024 * 1024, 65); bytes.write('%PDF-1.4');
    await fs.writeFile(path.join(root, 'large.pdf'), bytes);
    const metadata = await head('large.pdf');
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('content-length')).toBe(String(bytes.length));
    expect(metadata.headers.get('x-tower-file-version')).toBeTruthy();
    expect((await metadata.arrayBuffer()).byteLength).toBe(0);
    const probe = await get('large.pdf', 'bytes=0-65535');
    expect(probe.status).toBe(206);
    expect(probe.headers.get('content-range')).toBe(`bytes 0-65535/${bytes.length}`);
    expect(Buffer.from(await probe.arrayBuffer())).toEqual(bytes.subarray(0,65536));
    await fs.writeFile(path.join(root, 'empty.pdf'), '');
    const empty = await head('empty.pdf');
    expect(empty.headers.get('content-length')).toBe('0');
    expect((await empty.arrayBuffer()).byteLength).toBe(0);
    expect((await head('large.pdf', 'unknown')).status).toBe(403);
    expect((await head('large.pdf', 'p', 'wrong')).status).toBe(401);
    expect((await head('../escape.pdf')).status).toBe(404);
  });

  it('streams single byte ranges without buffering the complete file', async () => {
    const { put, get } = await fixture();
    await put('video.bin', '0123456789');
    const bounded = await get('video.bin', 'bytes=2-5');
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get('accept-ranges')).toBe('bytes');
    expect(bounded.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(bounded.headers.get('content-length')).toBe('4');
    expect(await bounded.text()).toBe('2345');
    const suffix = await get('video.bin', 'bytes=-3');
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(await suffix.text()).toBe('789');
  });

  it('rejects invalid or unsatisfiable ranges without returning file bytes', async () => {
    const { put, get } = await fixture();
    await put('video.bin', '0123456789');
    for (const range of ['bytes=20-30', 'bytes=8-2', 'bytes=0-1,4-5', 'items=0-1']) {
      const response = await get('video.bin', range);
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
      expect(await response.text()).toBe('');
    }
  });

  it('does not broaden an existing private file when replacing its content', async () => {
    const { root, put } = await fixture();
    const target = path.join(root, 'private.txt');
    await fs.writeFile(target, 'before', { mode: 0o600 });
    expect((await put('private.txt', 'after')).status).toBe(200);
    expect(await fs.readFile(target, 'utf8')).toBe('after');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it('retains authentication, allowlist, and relative-path rejection before publication', async () => {
    const { root, put } = await fixture();
    expect((await put('file.txt', 'body', 'p', 'wrong-token')).status).toBe(401);
    expect((await put('file.txt', 'body', 'unknown')).status).toBe(403);
    expect((await put('../escape.txt', 'body')).status).toBe(400);
    expect((await put('.', 'body')).status).toBe(400);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
