import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const serviceSource = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/auth/signup-invites.ts'), 'utf8');
const panelSource = fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/components/admin/AdminPanel.tsx'), 'utf8');

describe('signup invite retention source contract', () => {
  it('retires invite codes instead of deleting provenance rows', () => {
    expect(serviceSource).toContain('UPDATE signup_invite_codes SET disabled = 1 WHERE id = $1');
    expect(serviceSource).not.toContain("execute('DELETE FROM signup_invite_codes");
  });

  it('does not expose a destructive invite delete control', () => {
    expect(panelSource).not.toContain('removeInvite(invite)');
    expect(panelSource).not.toContain('>삭제</button>');
  });
});
