import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./178_project_compute_authority_mode.sql', import.meta.url), 'utf8');

describe('project compute authority mode migration', () => {
  it('stores the explicit three-tier execution authority policy without credential material', () => {
    expect(migration).toContain("authority_mode TEXT NOT NULL DEFAULT 'project'");
    expect(migration).toContain("authority_mode IN ('project', 'operator-plane', 'sandbox')");
    expect(migration).not.toMatch(/token|secret|password/i);
  });
});
