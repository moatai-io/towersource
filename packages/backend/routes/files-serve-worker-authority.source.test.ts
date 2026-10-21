import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');
const route = source.slice(source.indexOf("router.get('/files/serve'"), source.indexOf('// ───── Prompts ─────'));

describe('/files/serve Worker Project authority contract', () => {
  it('authorizes the host-shaped path before resolving Worker authority', () => {
    expect(route.indexOf('isPathAccessible(filePath, userId, role)')).toBeGreaterThanOrEqual(0);
    expect(route.indexOf('resolveWorkerFileAuthorityForHostPath(filePath)')).toBeGreaterThan(route.indexOf('isPathAccessible(filePath, userId, role)'));
  });

  it('streams Worker bytes with range and preserves the host fallback', () => {
    expect(route).toContain('openWorkerProjectFileStream({');
    expect(route).toContain("range: !isDownload && ext && binaryTypes[ext] ? req.headers.range : undefined");
    expect(route).toContain('Readable.fromWeb(upstream.body as any)');
    expect(route).toContain("streamFileResponse(req, res, filePath");
    expect(route).not.toContain('await upstream.arrayBuffer()');
  });

  it('keeps download transfer audit on both Worker and host paths', () => {
    expect(route.match(/appendFileTransferEventSafe\(/g)).toHaveLength(2);
  });
});
