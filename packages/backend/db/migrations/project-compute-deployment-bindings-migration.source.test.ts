import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/183_project_compute_deployment_bindings.sql'), 'utf8');

describe('Project compute deployment bindings migration', () => {
  it('scopes one Worker-first binding to Project plus deployment', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS project_compute_deployment_bindings');
    expect(migration).toContain('PRIMARY KEY(project_id, deployment_id)');
    expect(migration).toContain("deployment_id ~ '^[A-Za-z0-9._-]{1,120}$'");
    expect(migration).toContain("authority_mode IN ('project','operator-plane','sandbox')");
  });
});
