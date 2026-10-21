import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ execute, query, queryOne }));

const { bindDecisionSpec, decisionSpecHash, listBoundDecisionSpecs, publishDecisionSpec, requireBoundDecisionSpec } = await import('./decision-spec-repository.js');
const { TOWER_REQUEST_ROUTING_SPEC } = await import('./examples.js');

describe('DecisionSpec repository', () => {
  beforeEach(() => { execute.mockReset(); query.mockReset(); queryOne.mockReset(); });

  it('publishes validated immutable identity and deterministic content hash', async () => {
    execute.mockResolvedValue({ changes: 1 });
    await publishDecisionSpec({ spec: TOWER_REQUEST_ROUTING_SPEC, userId: 7 });
    expect(decisionSpecHash(TOWER_REQUEST_ROUTING_SPEC)).toMatch(/^[a-f0-9]{64}$/);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO decision_spec_versions'), expect.arrayContaining(['tower.request-routing', 1, 1]));
  });

  it('rejects cross-project project bindings before touching storage', async () => {
    await expect(bindDecisionSpec({ projectId: 'project-a', principal: { type: 'project', id: 'project-b' }, specId: 'tower.request-routing', specRevision: 1 })).rejects.toThrow('PROJECT_ID_MISMATCH');
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires an exact active binding and fails closed when absent', async () => {
    queryOne.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ spec: TOWER_REQUEST_ROUTING_SPEC });
    const input = { projectId: 'project-a', principal: { type: 'agent' as const, id: 'agent-a' }, specId: 'tower.request-routing', specRevision: 1 };
    await expect(requireBoundDecisionSpec(input)).rejects.toThrow('DECISION_SPEC_ACCESS_DENIED');
    await expect(requireBoundDecisionSpec(input)).resolves.toMatchObject({ id: 'tower.request-routing', revision: 1 });
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("b.state='active'"), ['project-a', 'agent', 'agent-a', 'tower.request-routing', 1]);
  });

  it('lists only storage-filtered active bindings and revalidates persisted specs', async () => {
    query.mockResolvedValue([{ spec: TOWER_REQUEST_ROUTING_SPEC }]);
    await expect(listBoundDecisionSpecs({ projectId: 'project-a', principal: { type: 'project', id: 'project-a' } })).resolves.toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("b.state='active'"), ['project-a', 'project', 'project-a']);
    query.mockResolvedValue([{ spec: { ...TOWER_REQUEST_ROUTING_SPEC, mode: 'live' } }]);
    await expect(listBoundDecisionSpecs({ projectId: 'project-a', principal: { type: 'project', id: 'project-a' } })).rejects.toThrow();
  });
});
