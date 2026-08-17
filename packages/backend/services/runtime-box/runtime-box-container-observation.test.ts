import { describe, expect, it, vi } from 'vitest';
import { observeRuntimeBoxContainer, type DockerInspectResult } from './runtime-box-container-observation.js';

const base = {
  Id: 'sha256:abc',
  Name: '/tower-box-42',
  Config: { Labels: { 'tower.box.id': '42', 'tower.project.id': 'project-a' } },
  State: { Running: true },
};

function result(overrides: Partial<DockerInspectResult> = {}): DockerInspectResult {
  return { stdout: JSON.stringify([base]), stderr: '', exitCode: 0, timedOut: false, ...overrides };
}

async function observe(response: DockerInspectResult | Error) {
  return observeRuntimeBoxContainer({
    containerRef: 'tower-box-42',
    expectedBoxId: 42,
    expectedProjectId: 'project-a',
    inspect: vi.fn().mockImplementation(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  });
}

describe('Runtime Box Docker observation typing', () => {
  it('classifies timeout and daemon errors as inspection_unknown', async () => {
    await expect(observe(result({ exitCode: -1, timedOut: true, stderr: 'timeout' }))).resolves.toMatchObject({ kind: 'inspection_unknown' });
    await expect(observe(result({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon' }))).resolves.toMatchObject({ kind: 'inspection_unknown' });
    await expect(observe(new Error('spawn failed'))).resolves.toEqual({ kind: 'inspection_unknown', error: 'spawn failed' });
  });

  it('recognizes only explicit Docker not-found signals as not_found', async () => {
    await expect(observe(result({ exitCode: 1, stderr: 'Error: No such container: tower-box-42' }))).resolves.toEqual({ kind: 'not_found' });
    await expect(observe(result({ exitCode: 1, stderr: 'permission denied' }))).resolves.toMatchObject({ kind: 'inspection_unknown' });
  });

  it('returns verified running and not_running identities', async () => {
    await expect(observe(result())).resolves.toEqual({
      kind: 'running',
      identity: { containerId: 'sha256:abc', containerName: 'tower-box-42', boxId: 42, projectId: 'project-a' },
    });
    await expect(observe(result({ stdout: JSON.stringify([{ ...base, State: { Running: false } }]) }))).resolves.toMatchObject({ kind: 'not_running' });
  });

  it('rejects Box or Project label mismatch without conferring ownership', async () => {
    await expect(observe(result({ stdout: JSON.stringify([{ ...base, Config: { Labels: { ...base.Config.Labels, 'tower.box.id': '99' } } }]) })))
      .resolves.toMatchObject({ kind: 'identity_mismatch', observed: { boxId: '99' } });
    await expect(observe(result({ stdout: JSON.stringify([{ ...base, Config: { Labels: { ...base.Config.Labels, 'tower.project.id': 'project-b' } } }]) })))
      .resolves.toMatchObject({ kind: 'identity_mismatch', observed: { projectId: 'project-b' } });
  });

  it('treats malformed or incomplete successful inspect output as unknown', async () => {
    await expect(observe(result({ stdout: 'not-json' }))).resolves.toMatchObject({ kind: 'inspection_unknown' });
    await expect(observe(result({ stdout: JSON.stringify([{ ...base, Id: undefined }]) }))).resolves.toMatchObject({ kind: 'inspection_unknown' });
    await expect(observe(result({ stdout: JSON.stringify([]) }))).resolves.toMatchObject({ kind: 'inspection_unknown' });
  });
});
