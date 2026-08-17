import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/personal-space-api.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('./personal-space-store.ts', import.meta.url), 'utf8');

describe('Personal Space disk-first upload contract', () => {
  it('stages multipart bytes on disk and never consumes file.buffer', () => {
    expect(route).toContain("path.join(config.dataDir, 'upload-staging', 'personal-files')");
    expect(route).toContain('multer.diskStorage');
    expect(route).not.toContain('multer.memoryStorage');
    const start = route.indexOf("router.post('/files/upload'");
    const end = route.indexOf("router.get('/files/content'", start);
    const uploadRoute = route.slice(start, end);
    expect(uploadRoute).toContain('createPersonalBinaryFileFromPath');
    expect(uploadRoute).toContain('file.path');
    expect(uploadRoute).not.toContain('file.buffer');
  });

  it('cleans staging on response finish and close', () => {
    expect(route).toContain("res.once('finish', cleanup)");
    expect(route).toContain("res.once('close', cleanup)");
    expect(route).toContain('path.resolve(file.path).startsWith(root)');
    expect(route).toContain('fs.rm(file.path, { force: true })');
  });

  it('streams source bytes, hashes them, and compensates metadata failures', () => {
    expect(store).toContain('export async function createPersonalBinaryFileFromPath');
    expect(store).toContain('createReadStream(sourcePath)');
    expect(store).toContain('createWriteStream(temporaryDestination');
    expect(store).toContain('await pipeline(source,');
    expect(store).toContain('await fs.rename(temporaryDestination, destination)');
    expect(store).toContain("crypto.createHash('sha256')");
    expect(store).toContain('await fs.rm(destination, { force: true })');
  });

  it('preserves the established partial-success response', () => {
    expect(route).toContain('if (created.length) return res.status(207)');
  });
});
