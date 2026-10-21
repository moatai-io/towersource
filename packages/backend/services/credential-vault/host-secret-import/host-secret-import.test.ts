import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../credential-vault-service.js', () => ({
  upsertApiKeyCredential: vi.fn(async () => ({ id: 'imported' })),
  auditCredentialEvent: vi.fn(async () => undefined),
}));

import { applyHostSecretImport, previewHostSecretImport } from './host-secret-import.js';
import { auditCredentialEvent, upsertApiKeyCredential } from '../credential-vault-service.js';

const request = (sourcePath: string) => ({
  sourcePath, sourceKey: 'SOURCE_KEY', projectId: 'project-1', credentialId: 'imported-key',
  provider: 'custom', displayName: 'Imported key', secretName: 'IMPORTED_KEY', envName: 'IMPORTED_KEY',
});

describe('host secret import', () => {
  let dir: string;
  let sourcePath: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-secret-import-'));
    sourcePath = path.join(dir, 'source.env');
    await fs.writeFile(sourcePath, 'OTHER=x\nSOURCE_KEY="super-secret-value"\n', { mode: 0o600 });
    process.env.TOWER_HOST_SECRET_IMPORT_ALLOWLIST_JSON = JSON.stringify([{ path: sourcePath, keys: ['SOURCE_KEY'] }]);
  });
  afterEach(async () => {
    delete process.env.TOWER_HOST_SECRET_IMPORT_ALLOWLIST_JSON;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('previews metadata without reading or returning the secret', async () => {
    const preview = await previewHostSecretImport(request(sourcePath), 1);
    expect(JSON.stringify(preview)).not.toContain('super-secret-value');
    expect(preview.source).toEqual({ path: sourcePath, key: 'SOURCE_KEY' });
    expect(preview.proposalHash).toHaveLength(64);
    expect(upsertApiKeyCredential).not.toHaveBeenCalled();
    expect(auditCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'host_secret_import_previewed', actorUserId: 1,
      credentialId: 'imported-key', projectId: 'project-1',
    }));
  });

  it('imports the approved key and returns only non-secret metadata', async () => {
    const preview = await previewHostSecretImport(request(sourcePath));
    const result = await applyHostSecretImport({ intentId: preview.intentId, proposalHash: preview.proposalHash, actorUserId: 1 });
    expect(upsertApiKeyCredential).toHaveBeenCalledWith(expect.objectContaining({ secretValue: 'super-secret-value', scope: 'project', projectId: 'project-1' }));
    expect(auditCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'host_secret_import_applied', actorUserId: 1,
      credentialId: 'imported-key', projectId: 'project-1',
    }));
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('fails closed for non-allowlisted paths, changed sources and reused intents', async () => {
    process.env.TOWER_HOST_SECRET_IMPORT_ALLOWLIST_JSON = '[]';
    await expect(previewHostSecretImport(request(sourcePath))).rejects.toThrow('not allowlisted');
    process.env.TOWER_HOST_SECRET_IMPORT_ALLOWLIST_JSON = JSON.stringify([{ path: sourcePath, keys: ['SOURCE_KEY'] }]);
    const preview = await previewHostSecretImport(request(sourcePath));
    await fs.appendFile(sourcePath, '# changed\n');
    await expect(applyHostSecretImport({ intentId: preview.intentId, proposalHash: preview.proposalHash, actorUserId: 1 })).rejects.toThrow('changed after preview');
    await expect(applyHostSecretImport({ intentId: preview.intentId, proposalHash: preview.proposalHash, actorUserId: 1 })).rejects.toThrow('valid unused');
  });
});
