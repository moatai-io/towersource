import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPdfAwareReadTool } from '../pi-pdf-aware-read-tool.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(name: string, bytes: Buffer | string): Promise<{ root: string; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-attachment-policy-'));
  roots.push(root);
  const file = path.join(root, name);
  await fs.writeFile(file, bytes);
  return { root, file };
}

describe('Pi read attachment representation boundary', () => {
  it('returns bounded text for ordinary Markdown', async () => {
    const { root, file } = await fixture('notes.md', '# Safe notes\nhello');
    const tool = createPdfAwareReadTool({ cwd: root, sessionId: 's1', userId: 1, userRole: 'member' });
    const result = await tool.execute('t1', { path: file }, undefined, undefined);
    expect(result.content[0].text).toContain('# Safe notes');
    expect(result.details.attachmentRepresentation).toMatchObject({ classification: 'text', modelMode: 'bounded-text' });
  });

  it('does not inline a base64-heavy Markdown file', async () => {
    const { root, file } = await fixture('bomb.md', `# Bomb\n${'Q'.repeat(16 * 1024)}`);
    const tool = createPdfAwareReadTool({ cwd: root, sessionId: 's1', userId: 1, userRole: 'member' });
    const result = await tool.execute('t1', { path: file }, undefined, undefined);
    expect(result.content[0].text).toContain('File stored but not inlined');
    expect(result.content[0].text).not.toContain('QQQQQQ');
    expect(result.details.attachmentRepresentation).toMatchObject({ classification: 'opaque', modelMode: 'reference-only' });
  });

  it('does not decode a ZIP renamed to txt as UTF-8', async () => {
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(128)]);
    const { root, file } = await fixture('archive.txt', bytes);
    const tool = createPdfAwareReadTool({ cwd: root, sessionId: 's1', userId: 1, userRole: 'member' });
    const result = await tool.execute('t1', { path: file }, undefined, undefined);
    expect(result.content[0].text).toContain('classification=archive');
    expect(result.details.attachmentRepresentation).toMatchObject({ classification: 'archive', modelMode: 'tool-required' });
  });

  it('lets the native image path create a bounded vision block after magic-byte classification', async () => {
    // A complete 1x1 PNG. The Pi image processor may normalize it, but it must
    // never be decoded as ordinary UTF-8 text.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const { root, file } = await fixture('image.txt', png);
    const tool = createPdfAwareReadTool({ cwd: root, sessionId: 's1', userId: 1, userRole: 'member' });
    const result = await tool.execute('t1', { path: file }, undefined, undefined);
    expect(result.content.some((block: any) => block.type === 'image' || /Image omitted|Read image file/.test(block.text || ''))).toBe(true);
  });
});
