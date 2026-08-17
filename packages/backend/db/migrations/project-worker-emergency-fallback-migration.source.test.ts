import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/184_project_worker_emergency_fallback_intents.sql'), 'utf8');
const routes = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/workbench-worker-api.ts'), 'utf8');

describe('Project Worker emergency fallback contract', () => {
  it('stores exact expiring binding snapshots without Worker secret material', () => {
    expect(migration).toContain('project_worker_emergency_fallback_intents');
    expect(migration).toContain('expected_binding JSONB NOT NULL');
    expect(migration).toContain("proposal_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).not.toMatch(/token|password|credential/i);
  });

  it('registers Project emergency routes before the generic Worker id route', () => {
    const preview = routes.indexOf("/projects/:projectId/emergency-fallback/preview");
    const workerRoute = routes.indexOf("/:workerId/drain");
    expect(preview).toBeGreaterThan(0);
    expect(preview).toBeLessThan(workerRoute);
    expect(routes).toContain('previewProjectWorkerEmergencyFallback');
    expect(routes).toContain('applyProjectWorkerEmergencyFallback');
  });
});
