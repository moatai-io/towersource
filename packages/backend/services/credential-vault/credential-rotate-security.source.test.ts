import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('./credential-rotate-assistant.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../db/migrations/157_credential_rotate_intents.sql', import.meta.url), 'utf8');

const rotateBlock = route.slice(route.indexOf("router.post('/credentials/:credentialId/rotate/preview'"), route.indexOf("router.post('/credentials/:credentialId/reveal-challenges'"));

describe('credential rotate security contract', () => {
  it('never stores or audits candidate plaintext', () => {
    expect(migration).not.toMatch(/candidate|secret_value|password/i);
    expect(service).toContain("createHmac('sha256', config.jwtSecret)");
    const insertStatement = rotateBlock.match(/INSERT INTO credential_rotate_intents\s*\(([^)]*)\)/)?.[1] || '';
    expect(insertStatement).not.toMatch(/candidate|secret_value|password/i);
    expect(rotateBlock).not.toMatch(/targetRef:\s*\{[^}]*candidate/s);
  });

  it('atomically claims once and records final success or failure', () => {
    expect(migration).toContain("'applying'");
    expect(rotateBlock).toContain("SET status = 'applying', consumed_at = now()");
    expect(rotateBlock).toContain("WHERE id = $1 AND status = 'previewed' AND consumed_at IS NULL AND expires_at > now() RETURNING id");
    expect(rotateBlock).toContain("SET status = 'applied' WHERE id = $1 AND status = 'applying'");
    expect(rotateBlock).toContain("SET status = 'failed' WHERE id = $1 AND status = 'applying'");
  });

  it('requires admin, no-store, exact proposal and explicit confirmation', () => {
    expect(rotateBlock.match(/assertAdmin\(req\)/g)?.length).toBe(2);
    expect(rotateBlock.match(/Cache-Control', 'no-store, private'/g)?.length).toBe(2);
    expect(rotateBlock).toContain("req.body?.confirmed !== true");
    expect(rotateBlock).toContain('i.proposal_hash = $4');
    expect(rotateBlock).toContain("i.status = 'previewed' AND i.consumed_at IS NULL AND i.expires_at > now()");
  });
});
