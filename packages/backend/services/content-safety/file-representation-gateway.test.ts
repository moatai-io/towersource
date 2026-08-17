import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareFileRepresentation,
  readPreparedVisionImage,
  requireDetectedMime,
} from './file-representation-gateway.js';

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

  it('enforces the central image byte budget before base64 materialization', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8 * 1024 * 1024)]);
    const { root, file } = await fixture('large.jpg', bytes);
    const prepared = await prepareFileRepresentation(file, { cwd: root });
    await expect(readPreparedVisionImage(prepared)).rejects.toThrow(/model representation budget/);
  });
});
