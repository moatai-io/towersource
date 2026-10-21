import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Admin Credential deletion confirmation', () => {
  it('requires confirmation before deleting a shared Credential', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'packages/frontend/src/components/admin/AdminPanel.tsx'), 'utf8');
    const block = source.slice(source.indexOf('const deleteConnection = async'));
    expect(block).toContain("await confirm({");
    expect(block).toContain("credentialConnections.deleteConfirmTitle");
    expect(block).toContain("credentialConnections.deleteConfirmMessage");
    expect(block).toContain("credentialConnections.deletePermanently");
    expect(block).toContain('danger: true');
  });
});
