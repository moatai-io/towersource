import { describe, expect, it, vi } from 'vitest';
import { query } from '../../db/pg-repo.js';
import {
  auditProjectWorkerAuthority,
  classifyProjectWorkerAuthorityRow,
  type ProjectWorkerAuthorityAuditRow,
} from './workbench-project-worker-authority-audit.js';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));

const base: ProjectWorkerAuthorityAuditRow = {
  project_id: 'project-a', project_name: 'Project A', root_path: '/workspace/project-a',
  settings_worker_id: 'worker-a', settings_workstation_mode: true,
  binding_worker_id: 'worker-a', binding_workstation_mode: true,
  settings_worker_exists: true, settings_worker_project_ids: ['project-a'], binding_worker_exists: true, binding_worker_project_ids: ['project-a'],
  rollout_status: 'enabled', desire_worker_id: 'worker-a', desire_status: 'active',
};

describe('Project Worker authority audit', () => {
  it('accepts a fully scoped and consistent Worker binding', () => {
    expect(classifyProjectWorkerAuthorityRow(base)).toBeUndefined();
  });

  it('flags enabled file authority without static Worker Project scope as critical', () => {
    expect(classifyProjectWorkerAuthorityRow({ ...base, settings_worker_project_ids: [], binding_worker_project_ids: [] })).toMatchObject({
      severity: 'critical', problems: ['file_authority_scope_missing'],
    });
  });

  it('flags signed-grant activation intent when the effective file binding lacks scope', () => {
    expect(classifyProjectWorkerAuthorityRow({
      ...base,
      settings_workstation_mode: false,
      settings_worker_project_ids: [], binding_worker_project_ids: [],
    })).toMatchObject({ severity: 'critical', problems: ['file_authority_scope_missing'] });
  });

  it('reports rollout and desired-state drift without inventing file divergence', () => {
    expect(classifyProjectWorkerAuthorityRow({
      ...base,
      settings_workstation_mode: false,
      rollout_status: 'disabled',
      desire_worker_id: 'worker-b',
    })).toMatchObject({
      severity: 'warning',
      problems: ['rollout_not_enabled', 'active_desire_worker_mismatch'],
    });
  });

  it('queries active Projects read-only for one deployment', async () => {
    vi.mocked(query).mockResolvedValue([{ ...base, settings_worker_project_ids: [], binding_worker_project_ids: [] }]);
    await expect(auditProjectWorkerAuthority('customer-a')).resolves.toHaveLength(1);
    expect(vi.mocked(query).mock.calls[0][0]).toContain('SELECT p.id AS project_id');
    expect(vi.mocked(query).mock.calls[0][0]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(['customer-a']);
  });
});

it('does not inherit legacy file authority in production or an explicitly disabled deployment', () => {
  expect(classifyProjectWorkerAuthorityRow({ ...base, binding_workstation_mode: false, desire_status: null })).toBeUndefined();
  const legacyOnly = { ...base, binding_workstation_mode: null, binding_worker_id: null, desire_status: null, settings_worker_project_ids: [] };
  expect(classifyProjectWorkerAuthorityRow(legacyOnly)).toBeUndefined();
  expect(classifyProjectWorkerAuthorityRow(legacyOnly, 'development')).toMatchObject({ problems: ['file_authority_scope_missing'] });
});
it('reports incomplete enabled storage bindings', () => {
  expect(classifyProjectWorkerAuthorityRow({ ...base, binding_worker_id: null, desire_status: null })).toMatchObject({ problems: ['file_authority_binding_incomplete'], severity: 'critical' });
});
