import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const route = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/credential-vault-api.ts'), 'utf8');

describe('Agent Credential import candidate Project naming', () => {
  it('uses the current projects schema and never references the removed slug column', () => {
    const block = route.slice(
      route.indexOf("router.get('/projects/:projectId/credentials/import-candidates'"),
      route.indexOf("router.post('/projects/:projectId/credentials/import'"),
    );
    expect(block).toContain("COALESCE(NULLIF(pap.display_name, ''), p.name, c.project_id::text) AS project_name");
    expect(block).not.toContain('p.slug');
  });
});
