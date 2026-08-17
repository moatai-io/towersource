import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const execute = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({ queryOne, execute }));

const { getOrPinSessionHarnessSnapshot, getPinnedSessionHarnessSnapshot, resolveBoundHarnessBinding, resolveBoundHarnessId } = await import('./harness-store.js');

const quickSnapshot = {
  id: 'quick-web-research',
  version: 1,
  runtimeProfileId: 'web-only',
  runtimeProfileVersion: 1,
  engine: 'pi',
  defaultModel: 'litellm-responses/smart',
  allowedModels: ['litellm-responses/smart'],
  prompt: {
    includePlatformKernel: true,
    includeAgentIdentity: true,
    includeProjectInstructions: false,
    includeMemory: false,
    includeSkills: false,
    fragments: [],
  },
  capabilityIds: ['web.fetch', 'web.search'],
  sandboxMode: 'none',
  networkMode: 'platform-default',
  source: 'database',
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function persistedRow(snapshot: typeof quickSnapshot = quickSnapshot, overrides: Record<string, unknown> = {}) {
  return {
    harness_id: snapshot.id,
    harness_version: snapshot.version,
    runtime_profile_id: snapshot.runtimeProfileId,
    runtime_profile_version: snapshot.runtimeProfileVersion,
    engine: snapshot.engine,
    snapshot,
    snapshot_hash: createHash('sha256').update(stable(snapshot)).digest('hex'),
    prompt_bundle_hash: null,
    ...overrides,
  };
}

describe('Harness binding and Session snapshot store', () => {
  beforeEach(() => {
    queryOne.mockReset();
    execute.mockReset();
  });

  it('resolves the complete Project Agent Harness binding without discarding versions', async () => {
    queryOne.mockResolvedValueOnce({
      harness_id: 'quick-web-research',
      harness_version: 1,
      runtime_profile_id: 'web-only',
      runtime_profile_version: 1,
    });
    await expect(resolveBoundHarnessBinding('project-1')).resolves.toEqual({
      harnessId: 'quick-web-research',
      harnessVersion: 1,
      runtimeProfileId: 'web-only',
      runtimeProfileVersion: 1,
    });
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('runtime_profile_version'), ['project-1']);
  });

  it('keeps the id-only compatibility helper backed by the complete binding resolver', async () => {
    queryOne.mockResolvedValueOnce({
      harness_id: 'quick-web-research',
      harness_version: 1,
      runtime_profile_id: 'web-only',
      runtime_profile_version: 1,
    });
    await expect(resolveBoundHarnessId('project-1')).resolves.toBe('quick-web-research');
  });

  it('returns an existing immutable Session snapshot without reading the mutable Project binding', async () => {
    queryOne.mockResolvedValueOnce(persistedRow());
    const result = await getOrPinSessionHarnessSnapshot({
      sessionId: 'session-1',
      projectId: 'project-1',
      requestedEngine: 'pi',
    });

    expect(result).toMatchObject({ id: 'quick-web-research', version: 1 });
    expect(result.prompt.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('SET prompt_bundle_hash=$2'), ['session-1', result.prompt.bundleHash]);
  });

  it('requires an existing snapshot for native-session resume without consulting the Project binding', async () => {
    queryOne.mockResolvedValueOnce(undefined);

    await expect(getPinnedSessionHarnessSnapshot({
      sessionId: 'resume-session',
      requestedEngine: 'pi',
      requestedModel: 'litellm-responses/smart',
    })).rejects.toThrow('Pinned Harness snapshot is required to resume Session resume-session');

    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('loads the pinned Harness for native-session resume without reading the mutable Project binding', async () => {
    queryOne.mockResolvedValueOnce(persistedRow());

    const result = await getPinnedSessionHarnessSnapshot({
      sessionId: 'resume-session',
      requestedEngine: 'pi',
      requestedModel: 'litellm-responses/smart',
    });

    expect(result).toMatchObject({ id: 'quick-web-research', runtimeProfileId: 'web-only' });
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects a persisted snapshot whose hash no longer matches its JSON', async () => {
    queryOne.mockResolvedValueOnce(persistedRow(quickSnapshot, { snapshot_hash: 'tampered' }));

    await expect(getPinnedSessionHarnessSnapshot({
      sessionId: 'resume-session',
      requestedEngine: 'pi',
    })).rejects.toThrow('Pinned Harness snapshot hash mismatch for Session resume-session');

    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a persisted snapshot whose normalized tuple disagrees with its JSON', async () => {
    queryOne.mockResolvedValueOnce(persistedRow(quickSnapshot, { harness_id: 'tower-default' }));

    await expect(getPinnedSessionHarnessSnapshot({
      sessionId: 'resume-session',
      requestedEngine: 'pi',
    })).rejects.toThrow('Pinned Harness snapshot tuple mismatch for Session resume-session');

    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted snapshot JSON instead of treating it as missing', async () => {
    queryOne.mockResolvedValueOnce(persistedRow(quickSnapshot, { snapshot: { id: 'broken' } }));

    await expect(getPinnedSessionHarnessSnapshot({
      sessionId: 'resume-session',
      requestedEngine: 'pi',
    })).rejects.toThrow('Pinned Harness snapshot is invalid for Session resume-session');
  });

  it('rejects a model that conflicts with an existing pinned snapshot', async () => {
    queryOne.mockResolvedValueOnce(persistedRow());
    await expect(getOrPinSessionHarnessSnapshot({
      sessionId: 'session-1',
      projectId: 'project-1',
      requestedEngine: 'pi',
      requestedModel: 'litellm-responses/smartest',
    })).rejects.toThrow('does not allow model');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('SET prompt_bundle_hash=$2'), ['session-1', expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });

  it('atomically pins the current Project binding and returns the winning snapshot', async () => {
    queryOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ harness_id: 'quick-web-research', harness_version: 1, runtime_profile_id: 'web-only', runtime_profile_version: 1 })
      .mockResolvedValueOnce(persistedRow());
    execute.mockResolvedValueOnce({ changes: 1 });

    const result = await getOrPinSessionHarnessSnapshot({
      sessionId: 'session-1',
      projectId: 'project-1',
      requestedEngine: 'pi',
    });

    expect(result.id).toBe('quick-web-research');
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('prompt_bundle_hash'),
      expect.arrayContaining(['session-1', 'project-1', 'quick-web-research', 1, 'web-only']),
    );
    expect((execute.mock.calls[0][1] as unknown[]).at(-1)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('pins tower-default when a Project has no explicit binding', async () => {
    const defaultSnapshot = {
      ...quickSnapshot,
      id: 'tower-default',
      runtimeProfileId: 'standard',
      defaultModel: null,
      allowedModels: null,
      capabilityIds: [],
      sandboxMode: 'platform-default',
      source: 'legacy-default',
    };
    queryOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(persistedRow(defaultSnapshot));
    execute.mockResolvedValueOnce({ changes: 1 });

    const result = await getOrPinSessionHarnessSnapshot({
      sessionId: 'legacy-session',
      projectId: 'project-without-binding',
      requestedEngine: 'pi',
    });

    expect(result).toMatchObject({ id: 'tower-default', version: 1, source: 'legacy-default' });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('session_runtime_snapshots'),
      expect.arrayContaining(['legacy-session', 'project-without-binding', 'tower-default', 1, 'standard']),
    );
  });

  it('preserves the first winner when concurrent pinning loses the insert race', async () => {
    queryOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ harness_id: 'quick-web-research', harness_version: 1, runtime_profile_id: 'web-only', runtime_profile_version: 1 })
      .mockResolvedValueOnce(persistedRow());
    execute.mockResolvedValueOnce({ changes: 0 });

    const result = await getOrPinSessionHarnessSnapshot({
      sessionId: 'racing-session',
      projectId: 'project-1',
      requestedEngine: 'pi',
    });

    expect(result).toMatchObject({ id: 'quick-web-research', version: 1 });
  });
});
