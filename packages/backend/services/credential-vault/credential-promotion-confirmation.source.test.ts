import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const route = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/credential-vault-api.ts'), 'utf8');
const ui = fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/components/admin/AdminPanel.tsx'), 'utf8');

describe('Credential promotion explicit confirmation contract', () => {
  it('rejects promotion unless the admin explicitly confirmed the scope expansion', () => {
    const block = route.slice(
      route.indexOf("router.post('/admin/credentials/:credentialId/promote'"),
      route.indexOf("router.get('/credentials'"),
    );
    expect(block).toContain('req.body?.confirmed !== true');
    expect(block).toContain('Explicit confirmation is required');
    expect(block.indexOf('req.body?.confirmed !== true')).toBeLessThan(block.indexOf('promoteProjectCredentialToWorkspace'));
  });

  it('sends confirmation only after the UI confirmation dialog resolves', () => {
    const block = ui.slice(ui.indexOf('const promoteCredential = async'), ui.indexOf('const deleteConnection = async'));
    expect(block).toContain('if (!approved) return;');
    expect(block).toContain('confirmed: true');
    expect(block.indexOf('if (!approved) return;')).toBeLessThan(block.indexOf('confirmed: true'));
  });
});
