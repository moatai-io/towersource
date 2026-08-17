import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/api.ts'), 'utf8');
const resumableApi = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/resumable-upload-api.ts'), 'utf8');
const finder = fs.readFileSync(path.resolve(import.meta.dirname, '../../../frontend/src/components/files/FilesWorkspace.tsx'), 'utf8');
const migration = fs.readFileSync(path.resolve(import.meta.dirname, '../../db/migrations/116_file_transfer_events.sql'), 'utf8');

describe('Finder file transfers', () => {
  it('forces a native single-file download and keeps multi-selection ZIP', () => {
    expect(finder).toContain('download=1');
    expect(finder).toContain('/api/files/download-zip-selected?');
    expect(finder).toContain('paths: JSON.stringify(paths)');
  });

  it('records upload and download metadata without file contents', () => {
    expect(api).toContain("direction: 'upload'");
    expect(api).toContain("direction: 'download'");
    expect(api).toContain("transferKind: 'selection'");
    expect(resumableApi).toContain("transferKind: 'resumable'");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS file_transfer_events');
    expect(migration).toContain('never file contents');
  });
});
