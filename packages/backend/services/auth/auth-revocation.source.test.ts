import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const authSource = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/auth/auth.ts'), 'utf8');
const apiSource = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/api.ts'), 'utf8');
const wsSource = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/ws-handler.ts'), 'utf8');

describe('account revocation source contract', () => {
  it('disables the account and advances credential freshness together', () => {
    expect(authSource).toContain('SET disabled = 1, password_changed_at = NOW()');
  });

  it('checks disabled, approval, and current DB role for HTTP and WebSocket authentication', () => {
    expect(authSource).toContain('getUserAuthState(payload.userId)');
    expect(authSource).toContain("state.disabled || state.approvalStatus !== 'active'");
    expect(authSource).toContain('role FROM users WHERE id = $1');
    expect(authSource).toContain('effectivePayload = { ...payload, role: state.role }');
    expect(authSource).toContain('export async function verifyWsToken');
    expect(authSource).toContain('return payload.aud ? payload : { ...payload, role: state.role }');
  });

  it('disconnects existing sockets after the admin disables a user', () => {
    expect(apiSource).toContain('disconnectUserSockets(userId)');
    expect(wsSource).toContain('export function disconnectUserSockets');
    expect(wsSource).toContain('client.ws.close(4003');
  });
});
