import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const roomDir = import.meta.dirname;
const archive = fs.readFileSync(path.resolve(roomDir, 'internal-channel-archive.ts'), 'utf8');
const api = fs.readFileSync(path.resolve(roomDir, '../../routes/api.ts'), 'utf8');
const externalService = fs.readFileSync(path.resolve(roomDir, '../../routes/ai-service-public-api.ts'), 'utf8');

describe('retired internal Channel read-only archive', () => {
  it('exposes explicit authenticated manifest and paged message endpoints', () => {
    expect(api).toContain("router.get('/rooms/:id/archive', authMiddleware");
    expect(api).toContain("router.get('/rooms/:id/archive/messages', authMiddleware");
    const archiveStart = api.indexOf("router.get('/rooms/:id/archive'");
    const messagesStart = api.indexOf("router.get('/rooms/:id/archive/messages'");
    const routesEnd = api.indexOf("router.get('/rooms/:id'", messagesStart + 1);
    const routes = api.slice(archiveStart, routesEnd);
    expect(routes.match(/canAccessRoom\(/g)).toHaveLength(2);
    expect(routes).toContain('Content-Disposition');
  });

  it('is an allowlisted projection that excludes secrets and server paths', () => {
    expect(archive).toContain("readOnly: true");
    expect(archive).toContain('schemaVersion: 1');
    expect(archive).toContain('originalName: file.originalName');
    expect(archive).not.toContain('storagePath: file.storagePath');
    expect(archive).not.toContain('token_hash');
    expect(archive).not.toContain('rawToken');
    expect(archive).not.toContain('tokenId:');
    expect(archive).not.toContain('room_ai_context rac');
    expect(archive).toContain("'room_ai_context payloads'");
  });

  it('exports webhook migration metadata without credential material', () => {
    expect(archive).toContain('rwt.label');
    expect(archive).toContain('rwt.last_used_at');
    expect(archive).toContain("status: row.revoked_at ? 'revoked' : 'retired'");
    expect(archive).not.toMatch(/SELECT[^`]*token_hash/s);
    expect(archive).not.toMatch(/SELECT[^`]*rwt\.id/s);
  });

  it('bounds message export and strips arbitrary metadata keys', () => {
    expect(archive).toContain('const ARCHIVE_PAGE_MAX = 200');
    expect(archive).toContain("['source', 'model', 'status', 'legacyMode', 'token_label']");
    expect(archive).toContain('safeMessageMetadata(message.metadata)');
    expect(archive).not.toContain('metadata: message.metadata');
  });

  it('does not alter external AI Service channel routes', () => {
    expect(externalService).not.toContain('internal-channel-archive');
    expect(externalService).not.toContain('INTERNAL_CHANNEL_RETIRED');
  });
});
