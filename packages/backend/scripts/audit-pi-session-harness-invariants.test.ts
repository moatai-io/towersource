import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('../db/pg-repo.js', () => ({
  query: (...args: any[]) => queryMock(...args),
}));

const { auditPiSessionHarnessInvariants } = await import('./audit-pi-session-harness-invariants.js');

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

const snapshot = {
  id: 'tower-default',
  version: 1,
  runtimeProfileId: 'standard',
  runtimeProfileVersion: 1,
  engine: 'pi',
  capabilityIds: [],
  allowedModels: ['litellm-responses/smartest'],
  prompt: { fragments: [] },
};
const snapshotHash = createHash('sha256').update(stable(snapshot)).digest('hex');

function row(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'session-1',
    name: 'Pi Session',
    project_id: 'project-1',
    model_used: 'litellm-responses/smartest',
    updated_at: '2026-07-15T00:00:00.000Z',
    harness_id: 'tower-default',
    harness_version: 1,
    runtime_profile_id: 'standard',
    runtime_profile_version: 1,
    snapshot_engine: 'pi',
    snapshot,
    snapshot_hash: snapshotHash,
    ...overrides,
  };
}

describe('auditPiSessionHarnessInvariants', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns no finding for a consistent resumable Pi Session', async () => {
    queryMock.mockResolvedValue([row()]);
    await expect(auditPiSessionHarnessInvariants()).resolves.toEqual([]);
  });

  it('detects missing snapshots', async () => {
    queryMock.mockResolvedValue([row({
      harness_id: null,
      harness_version: null,
      runtime_profile_id: null,
      runtime_profile_version: null,
      snapshot_engine: null,
      snapshot: null,
      snapshot_hash: null,
    })]);
    await expect(auditPiSessionHarnessInvariants()).resolves.toEqual([
      expect.objectContaining({ problems: ['missing_or_invalid_snapshot'] }),
    ]);
  });

  it('detects tuple, hash, and model-policy mismatches', async () => {
    queryMock.mockResolvedValue([row({
      harness_id: 'other',
      snapshot_hash: 'bad',
      model_used: 'provider/disallowed',
    })]);
    const findings = await auditPiSessionHarnessInvariants();
    expect(findings[0]?.problems).toEqual(expect.arrayContaining([
      'harness_id_mismatch',
      'snapshot_hash_mismatch',
      'model_policy_mismatch',
    ]));
  });
});
