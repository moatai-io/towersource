import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/scripts/activate-oss-local-worker.ts'), 'utf8');
const bootstrap = fs.readFileSync(path.join(process.cwd(), 'scripts/oss/bootstrap-local-worker.sh'), 'utf8');

describe('Tower OSS local Worker bootstrap contract', () => {
  it('activates Worker-first only after healthy project scope is visible', () => {
    expect(source).toContain('getPersistedWorkbenchWorker(workerId)');
    expect(source).toContain("worker.status !== 'healthy'");
    expect(source).toContain('worker.projectIds.includes(projectId)');
    expect(source).not.toContain('SELECT status,project_ids');
    expect(source).toContain('activateProjectWorkerFirst');
    expect(source).toContain("rolloutCohort: 'oss-single-host'");
  });

  it('waits for the first admin, protects credentials, and runs a direct execution smoke', () => {
    expect(bootstrap).toContain("WHERE role='admin'");
    expect(bootstrap).toContain('chown root:"$EXECUTION_USER" /etc/tower-workers');
    expect(bootstrap).toContain('chmod 750 /etc/tower-workers');
    expect(bootstrap).toContain('install -o root -g "$EXECUTION_USER" -m 640');
    expect(bootstrap).toContain('/v1/runs');
    expect(bootstrap).toContain('pwd; printf oss-worker-smoke-ok');
    expect(bootstrap).toContain('grep -Fq "$PROJECT_ROOT"');
    expect(bootstrap).toContain('oss-worker-smoke-ok');
    expect(bootstrap).toContain('materialize-managed-skills.js');
    expect(bootstrap).not.toContain('echo "$transport"');
  });
});
