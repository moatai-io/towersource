import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/credential-vault-api.ts'), 'utf8');

describe('Google Connection cleanup removal', () => {
  it('removes the preview/apply cleanup workflow from the simplified Vault API', () => {
    expect(source).not.toContain('/admin/google-connections/cleanup/preview');
    expect(source).not.toContain('/admin/google-connections/cleanup/apply');
    expect(source).not.toContain('google_connection_cleanup_intents');
    expect(source).not.toContain('confirmedHighRisk');
  });
});
