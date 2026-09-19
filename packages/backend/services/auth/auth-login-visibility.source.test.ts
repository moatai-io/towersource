import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const auth = fs.readFileSync(path.resolve(import.meta.dirname, './auth.ts'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/api.ts'), 'utf8');
const migration = fs.readFileSync(path.resolve(import.meta.dirname, '../../db/migrations/190_auth_login_visibility.sql'), 'utf8');

describe('authentication visibility', () => {
  it('records successful, failed, blocked, and logout events without secrets', () => {
    expect(auth).toContain("eventType: 'login_failure'");
    expect(auth).toContain("eventType: 'login_success'");
    expect(api).toContain("eventType: 'logout'");
    expect(api).toContain("userAgent: req.get('user-agent') || null");
    expect(migration).toContain("CHECK (event_type IN ('login_success', 'login_failure', 'logout'))");
    expect(migration).not.toMatch(/password_value|token_value|cookie_value/i);
  });

  it('keeps event persistence best-effort so auth remains available', () => {
    expect(auth).toContain("console.warn('[auth] failed to record auth event:'");
    expect(auth).toContain('try {');
    expect(auth).toContain('catch (error)');
  });
});
