import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/api.ts'), 'utf8');

describe('checkpoint REST safety contract', () => {
  it('uses session access and rejects readonly roles', () => {
    expect(api).toContain("role === 'viewer' || role === 'guest'");
    expect(api).toContain('canAccessSession(sessionId, userId, role)');
    expect(api).toContain('Checkpoint restore requires write access');
  });
  it('exposes checkpoint read and preview without returning blobs', () => {
    expect(api).toContain("router.get('/sessions/:id/turns/:turnId/checkpoint'");
    expect(api).toContain("router.post('/checkpoints/:checkpointId/restore-preview'");
    expect(api).toContain('beforeSha256: c.before.sha256');
    expect(api).not.toContain('beforeContent: c.before.content');
  });
  it('requires explicit confirmation and exact preview hash for apply', () => {
    expect(api).toContain("router.post('/checkpoints/:checkpointId/restore'");
    expect(api).toContain('req.body?.confirmed !== true');
    expect(api).toContain('checkpoint_preview_hash_required');
    expect(api).toContain('previewHash: req.body.previewHash');
    expect(api).toContain("error.message === 'checkpoint_preview_stale' ? 409");
  });
});
