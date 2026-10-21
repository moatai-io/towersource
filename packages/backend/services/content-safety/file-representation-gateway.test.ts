import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareFileRepresentation,
  readPreparedVisionImage,
  requireDetectedMime,
  withPreparedLocalFile,
} from './file-representation-gateway.js';

const attachmentMocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../session-attachments/session-attachment-store.js', () => ({ resolveAuthorizedSessionAttachment: attachmentMocks.resolve }));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(name: string, bytes: Buffer | string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-file-gateway-'));
  roots.push(root);
  const file = path.join(root, name);
  await fs.writeFile(file, bytes);
  return { root, file };
}

describe('FileRepresentationGateway', () => {
  it('renders a session URI outside Project root without requiring a permanent Project copy', async () => {
    const { root, file } = await fixture('temporary.pdf', '%PDF-1.4\nsession');
    attachmentMocks.resolve.mockResolvedValue({ path: file, document: { name: 'temporary.pdf' } });
    const source = { stat: vi.fn(), readProbe: vi.fn(), readFile: vi.fn() };
    const uri = 'session://attachments/11111111-1111-4111-8111-111111111111';
    const prepared = await prepareFileRepresentation(uri, { cwd: root, projectRoot: root+'/project', projectSource: source, userId: 8, sessionId: 's1' });
    expect(prepared.temporary).toBe(true);
    await withPreparedLocalFile(prepared, source, 1000, async local => { expect(await fs.readFile(local, 'utf8')).toContain('%PDF'); });
    expect(source.stat).not.toHaveBeenCalled(); expect(source.readFile).not.toHaveBeenCalled();
    expect(attachmentMocks.resolve).toHaveBeenCalledWith(8, 's1', uri);
    expect(await fs.readdir(root)).toEqual(['temporary.pdf']);
  });

  it('normalizes a path and returns one representation decision', async () => {
    const { root, file } = await fixture('notes.md', '# Notes');
    const prepared = await prepareFileRepresentation(file, { cwd: root });
    expect(prepared).toMatchObject({ path: file, name: 'notes.md', temporary: false });
    expect(prepared.decision).toMatchObject({ classification: 'text', modelMode: 'bounded-text' });
  });

  it('uses magic bytes before a specialized PDF handler runs', async () => {
    const { root, file } = await fixture('fake.pdf', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]));
    const prepared = await prepareFileRepresentation(file, { cwd: root });
    expect(() => requireDetectedMime(prepared, ['application/pdf'], 'pdf_view')).toThrow(/detected application\/zip/);
  });

  it('normalizes transparent PNG and animated GIF to one bounded PNG frame', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-image-normalize-fixture-'));
    roots.push(root);
    const pngPath = path.join(root, 'transparent.png');
    const gifPath = path.join(root, 'animated.gif');
    const python = [
      'from PIL import Image',
      'import sys',
      "Image.new('RGBA', (32, 16), (255, 0, 0, 64)).save(sys.argv[1], 'PNG')",
      "a=Image.new('RGB',(16,16),(255,0,0)); b=Image.new('RGB',(16,16),(0,0,255))",
      "a.save(sys.argv[2], 'GIF', save_all=True, append_images=[b], duration=50, loop=0)",
    ].join('\n');
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => execFile(process.env.TOWER_DOCUMENT_PYTHON || 'python3', ['-c', python, pngPath, gifPath], error => error ? reject(error) : resolve()));

    for (const file of [pngPath, gifPath]) {
      const prepared = await prepareFileRepresentation(file, { cwd: root });
      const image = await readPreparedVisionImage(prepared);
      expect(image?.mimeType).toBe('image/png');
      expect(Buffer.from(image!.data, 'base64').subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
  });

  it('rejects image dimensions that would expand beyond the pixel budget', async () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(100_000, 16);
    png.writeUInt32BE(100_000, 20);
    const { root, file } = await fixture('pixel-bomb.png', png);
    const prepared = await prepareFileRepresentation(file, { cwd: root });
    await expect(readPreparedVisionImage(prepared)).rejects.toThrow(/pixel model representation budget/);
  });

  it('uses one installed Project source for both stat and probe without host-fs fallback', async () => {
    const { root, file } = await fixture('protected.json', Buffer.from('{"ok":true}'));
    const calls: string[] = [];
    const prepared = await prepareFileRepresentation(file, { cwd: root, projectRoot: root, projectSource: {
      async stat(target) { calls.push(`stat:${target}`); return { isFile: () => true, size: 11 }; },
      async readProbe(target, maxBytes) { calls.push(`probe:${target}:${maxBytes}`); return Buffer.from('{"ok":true}'); },
      async readFile(target, maxBytes) { calls.push(`read:${target}:${maxBytes}`); return Buffer.from('{"ok":true}'); },
    } });
    expect(prepared.sizeBytes).toBe(11);
    expect(calls).toEqual([`stat:${file}`, `probe:${file}:65536`]);
    await expect(prepareFileRepresentation(file, { cwd: root, projectRoot: root, projectSource: {
      async stat() { throw new Error('PROJECT_SOURCE_DENIED'); },
      async readProbe() { throw new Error('PROJECT_SOURCE_DENIED'); },
      async readFile() { throw new Error('PROJECT_SOURCE_DENIED'); },
    } })).rejects.toThrow('PROJECT_SOURCE_DENIED');
    await expect(prepareFileRepresentation(path.join(root, '..', 'other-project', 'secret.txt'), {
      cwd: root, projectRoot: root, projectSource: {
        async stat() { throw new Error('must not call source'); },
        async readProbe() { throw new Error('must not call source'); },
        async readFile() { throw new Error('must not call source'); },
      },
    })).rejects.toThrow('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
    expect(calls).toHaveLength(2);
  });

  it('stages Project bytes with exclusive private temp storage and always removes them', async () => {
    const { root, file } = await fixture('worker.pdf', 'host-shadow-must-not-be-read');
    const data = Buffer.from('%PDF-1.4\nworker-owned');
    const prepared = await prepareFileRepresentation(file, { cwd: root, projectRoot: root, projectSource: {
      async stat() { return { isFile: () => true, size: data.length }; },
      async readProbe(_target, max) { return data.subarray(0, max); },
      async readFile(_target, max) { expect(max).toBe(1024); return data; },
    } });
    let stagedPath = '';
    const value = await withPreparedLocalFile(prepared, {
      async stat() { return { isFile: () => true, size: data.length }; },
      async readProbe() { return data; },
      async readFile() { return data; },
    }, 1024, async localPath => {
      stagedPath = localPath;
      expect(await fs.readFile(localPath, 'utf8')).toBe(data.toString());
      expect((await fs.stat(localPath)).mode & 0o777).toBe(0o600);
      return 'rendered';
    });
    expect(value).toBe('rendered');
    await expect(fs.stat(path.dirname(stagedPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a staged Project file when the renderer throws', async () => {
    const { root, file } = await fixture('worker.pdf', 'host-shadow');
    const data = Buffer.from('%PDF-1.4\nworker-owned');
    const projectSource = {
      async stat() { return { isFile: () => true, size: data.length }; },
      async readProbe() { return data; },
      async readFile() { return data; },
    };
    const prepared = await prepareFileRepresentation(file, { cwd: root, projectRoot: root, projectSource });
    let stagedPath = '';
    await expect(withPreparedLocalFile(prepared, projectSource, 1024, async localPath => {
      stagedPath = localPath;
      throw new Error('synthetic renderer failure');
    })).rejects.toThrow('synthetic renderer failure');
    await expect(fs.stat(path.dirname(stagedPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects Project staging before byte download when metadata exceeds the budget', async () => {
    const { root, file } = await fixture('worker.pdf', 'host-shadow');
    const readFile = vi.fn();
    const projectSource = {
      async stat() { return { isFile: () => true, size: 2048 }; },
      async readProbe() { return Buffer.from('%PDF-1.4'); },
      readFile,
    };
    const prepared = await prepareFileRepresentation(file, { cwd: root, projectRoot: root, projectSource });
    await expect(withPreparedLocalFile(prepared, projectSource, 1024, async () => undefined)).rejects.toThrow(/staging budget/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('enforces the central image byte budget before base64 materialization', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8 * 1024 * 1024)]);
    const { root, file } = await fixture('large.jpg', bytes);
    const prepared = await prepareFileRepresentation(file, { cwd: root });
    await expect(readPreparedVisionImage(prepared)).rejects.toThrow(/model representation budget/);
  });
});
