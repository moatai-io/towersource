import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/scripts/reconcile-primary-worker-assignment.ts'), 'utf8');

describe('primary Worker assignment activation source', () => {
  it('uses the atomic Worker-first activation service after the assignment lease check', () => {
    expect(source).toContain('activateProjectWorkerFirstWithClient');
    expect(source).toContain("rolloutCohort: 'primary-worker-assignment'");
    expect(source).not.toContain('INSERT INTO project_compute_deployment_bindings');
  });
});
