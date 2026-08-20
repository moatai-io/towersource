import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../db/migrations/109_session_attachments.sql', import.meta.url), 'utf8');
const store = readFileSync(new URL('./session-attachment-store.ts', import.meta.url), 'utf8');
const input = readFileSync(new URL('../../../frontend/src/components/chat/InputBox.tsx', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../../engines/pi-session-attachment-tool.ts', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../routes/session-attachment-api.ts', import.meta.url), 'utf8');

describe('session-scoped attachment contract', () => {
  it('binds temporary files to owner and session with TTL', () => {
    expect(migration).toContain('owner_user_id');
    expect(migration).toContain('session_id');
    expect(migration).toContain("DEFAULT (NOW() + INTERVAL '7 days')");
    expect(store).toContain('owner_user_id = $2 AND session_id = $3');
  });

  it('requires project-connected chat uploads and returns permanent project paths', () => {
    expect(input).toContain('/api/session-attachments/');
    expect(input).not.toContain("fetch('/api/files/finalize-uploads'");
    expect(api).toContain("throw new SessionAttachmentError('CONFLICT', 'Chat uploads require a project-connected session')");
    expect(api).toContain('const attachment = await commitStagedProjectUpload');
    expect(api).not.toContain('const created = await createSessionAttachmentFromPath');
    expect(api).not.toContain('const attachment = await promoteSessionAttachmentToProject');
    expect(input).toContain('content: attachment.promotedUri || attachment.uri');
    expect(input).toContain("sessionAttachmentId: attachment.status === 'project_file' ? undefined : attachment.id");
  });

  it('keeps uploaded file bytes out of the provider message', () => {
    expect(input).toContain('parts.push(`[file: ${att.content}]`)');
    expect(input).toContain('parts.push(`[upload notice: ${att.label}]`)');
    expect(input).not.toContain('```\\n${att.content}\\n```');
  });

  it('automatically batches large selections within server count and byte limits', () => {
    expect(api).toContain("upload.array('files', 20)");
    expect(api).toContain('multer.diskStorage');
    expect(api).not.toContain('multer.memoryStorage');
    expect(api).toContain('commitStagedProjectUpload');
    expect(api).toContain('COPYFILE_EXCL');
    expect(api).toContain('await fs.rename(temporaryTarget, target)');
    expect(api).toContain('await fs.rm(temporaryTarget, { force: true })');
    expect(api).toContain('sourcePath: file.path');
    expect(api).toContain('await fs.rm(file.path, { force: true })');
    expect(api).toContain("res.once('finish', cleanup)");
    expect(api).toContain("res.once('close', cleanup)");
    expect(api).toContain('file.path.startsWith(path.resolve(stagingDir) + path.sep)');
    expect(api).toContain('MAX_UPLOAD_REQUEST_BYTES = 220 * 1024 * 1024');
    expect(api).toContain("res.status(413).json({ error: 'Upload batch is too large; send fewer files per request' })");
    expect(input).toContain('currentBatch.length >= 20 || currentBatchBytes + file.size > maxBatchBytes');
    expect(input).toContain('const maxBatchBytes = 200 * 1024 * 1024');
    expect(input).toContain('uploadedAttachments.push(...(data.attachments || []))');
  });

  it('keeps upload references path-only so a PPTX container cannot trigger compaction by itself', () => {
    expect(input).toContain('parts.push(`[file: ${att.content}]`)');
    expect(input).not.toContain('readAsDataURL');
    expect(input).not.toContain('arrayBuffer()');
    expect(input).not.toContain('```\\n${att.content}\\n```');
  });

  it('preserves successful files and reports per-file failures', () => {
    expect(api).toContain('const failures: Array<{ name: string; error: string }> = []');
    expect(api).toContain('const status = failures.length > 0 ? 207 : 200');
    expect(api).toContain('res.status(status).json({ attachments, failures })');
    expect(input).toContain('uploadFailures.push(...(data.failures || []))');
    expect(input).toContain("label: t('partialUploadFailed')");
  });

  it('bounds request disk staging and reports per-file partial success', () => {
    expect(api).toContain('const MAX_UPLOAD_REQUEST_BYTES = 220 * 1024 * 1024');
    expect(api).toContain("res.status(413).json({ error: 'Upload batch is too large; send fewer files per request' })");
    expect(api).toContain('const failures: Array<{ name: string; error: string }> = []');
    expect(api).toContain('const status = failures.length > 0 ? 207 : 200');
    expect(input).toContain('uploadFailures.push(...(data.failures || []))');
    expect(input).toContain("label: t('partialUploadFailed')");
  });

  it('avoids multiplying a large PDF batch through client-side chunking', () => {
    expect(input).toContain('const shouldPreservePdfBatch = pdfCount >= 10');
    expect(input).toContain('shouldPreservePdfBatch');
  });

  it('qualifies list and purge ordering when cast aliases duplicate base column names', () => {
    expect(store).toContain('ORDER BY session_attachments.created_at DESC');
    expect(store).toContain('ORDER BY session_attachments.expires_at ASC');
    expect(store).not.toMatch(/ORDER BY created_at DESC/);
    expect(store).not.toMatch(/ORDER BY expires_at ASC/);
  });

  it('lets authorized session readers view bytes while keeping each attachment actor-owned', () => {
    expect(api).toContain('canAccessSession(sessionId, userId, role)');
    expect(api).toContain('resolveReadableSessionAttachment(req.params.sessionId, req.params.attachmentId)');
    expect(api).toContain('assertSessionWritable(actor.id, actor.role, req.params.sessionId)');
    expect(api).toContain("role === 'viewer' || role === 'guest'");
    expect(api).toContain('deleteSessionAttachment(actor.id, req.params.sessionId, req.params.attachmentId)');
    expect(api).not.toContain('assertSessionOwner');
  });

  it('keeps explicit save tooling for personal copies and destination changes', () => {
    expect(tools).toContain("name: 'session_attachment_save'");
    expect(tools).toContain('Use only after an explicit user request');
    expect(tools).toContain('does not overwrite an existing project file');
  });
});
