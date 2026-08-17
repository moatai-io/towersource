import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, '../../routes/api.ts'), 'utf8');

describe('project upload disk staging source contract', () => {
  it('uses a lifecycle-specific disk uploader for project and folder uploads', () => {
    expect(source).toContain("const PROJECT_UPLOAD_STAGING_DIR = path.join(config.dataDir, 'upload-staging', 'project-files')");
    expect(source).toContain('const projectUpload = multer({');
    expect(source).toContain('storage: multer.diskStorage');
    expect(source).toContain("projectUpload.array('files', UPLOAD_MAX_FILES)");
    expect(source).toContain("router.post('/files/upload', handleProjectMulterUpload, withProjectUploadCleanup");
  });

  it('never consumes file.buffer in the project upload route', () => {
    const start = source.indexOf("router.post('/files/upload'");
    const end = source.indexOf("router.post('/files/chat-upload'", start);
    const route = source.slice(start, end);
    expect(route).toContain('await copyStagedProjectFile(file.path, filePath)');
    expect(route).not.toContain('file.buffer');
  });

  it('uses a temporary destination and response lifecycle cleanup', () => {
    expect(source).toContain('await fs.promises.copyFile(sourcePath, temporaryDestination)');
    expect(source).toContain('await fs.promises.rename(temporaryDestination, destinationPath)');
    expect(source).toContain("res.once('finish', cleanup)");
    expect(source).toContain("res.once('close', cleanup)");
    expect(source).toContain('void cleanupProjectUploadStaging(req)');
  });

  it('keeps legacy chat upload on its existing buffer contract instead of silently mixing lifecycles', () => {
    expect(source).toContain("router.post('/files/chat-upload', upload.array('files', UPLOAD_MAX_FILES)");
    const start = source.indexOf("router.post('/files/chat-upload'");
    const end = source.indexOf("router.post('/files/finalize'", start);
    expect(source.slice(start, end)).toContain('file.buffer');
  });
});
