import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync(new URL('../../routes/session-attachment-api.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('./session-attachment-store.ts', import.meta.url), 'utf8');

describe('shared-session attachment role matrix source contract', () => {
  it('uses session access as the read boundary for every actor', () => {
    expect(api).toContain('await assertSessionReadable(actor.id, actor.role, req.params.sessionId)');
    expect(api).toContain('canAccessSession(sessionId, userId, role)');
    expect(api).toContain('resolveReadableSessionAttachment(req.params.sessionId, req.params.attachmentId)');
  });

  it('requires owner/admin/operator content-write authority and rejects readonly roles', () => {
    expect(api).toContain("if (role === 'viewer' || role === 'guest')");
    expect(api).toContain("throw new SessionAttachmentError('FORBIDDEN', 'Session attachment write access denied')");
    expect(api).toContain('const access = await canWriteSessionContent(sessionId, userId, role)');
  });

  it('keeps staging deletion uploader-owned even when session readers can view bytes', () => {
    expect(api).toContain('deleteSessionAttachment(actor.id, req.params.sessionId, req.params.attachmentId)');
    expect(store).toContain('owner_user_id = $2 AND session_id = $3');
    expect(store).toContain('resolveReadableSessionAttachment');
  });

  it('rechecks project path write authority before promotion', () => {
    expect(store).toContain('isPathWritableByRole(targetDir, input.userId, input.userRole)');
    expect(store).toContain("throw new SessionAttachmentError('FORBIDDEN', 'Project upload access denied')");
  });
});
