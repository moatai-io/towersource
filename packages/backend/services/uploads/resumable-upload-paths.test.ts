import { describe, expect, it } from 'vitest';
import path from 'path';
import {
  normalizeRelativeUploadPath,
  resolveFinalUploadPath,
  chunkPath,
  stagingRootForSession,
} from './resumable-upload-paths.js';
import { UploadHttpError } from './resumable-upload-types.js';

describe('resumable-upload-paths', () => {
  it('normalizes browser relative paths', () => {
    expect(normalizeRelativeUploadPath('/folder\\child/file.txt')).toBe('folder/child/file.txt');
  });

  it('rejects path traversal segments', () => {
    expect(() => normalizeRelativeUploadPath('../secret.txt')).toThrow(UploadHttpError);
    expect(() => normalizeRelativeUploadPath('folder/../secret.txt')).toThrow(UploadHttpError);
  });

  it('allows script and executable-looking filenames as inert project upload inputs', () => {
    expect(normalizeRelativeUploadPath('bin/run.sh')).toBe('bin/run.sh');
    expect(normalizeRelativeUploadPath('installer.EXE')).toBe('installer.EXE');
    expect(normalizeRelativeUploadPath('backup/file.bak')).toBe('backup/file.bak');
  });

  it('keeps final upload path inside target directory', () => {
    const target = '/workspace/projects/demo/uploads/client-a';
    expect(resolveFinalUploadPath(target, 'nested/file.pdf')).toBe(path.resolve(target, 'nested/file.pdf'));
    expect(() => resolveFinalUploadPath(target, '../escape.pdf')).toThrow(UploadHttpError);
  });

  it('builds project-local staging paths', () => {
    const projectRoot = '/workspace/projects/demo';
    expect(stagingRootForSession(projectRoot, 'upl_1')).toBe('/workspace/projects/demo/uploads/.staging/upl_1');
    expect(chunkPath(projectRoot, 'upl_1', 'ulf_1', 3)).toBe('/workspace/projects/demo/uploads/.staging/upl_1/files/ulf_1/chunks/00000003.part');
  });
});
