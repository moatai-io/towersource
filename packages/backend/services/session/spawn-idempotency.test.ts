import { describe, expect, it } from 'vitest';
import { buildSpawnRequestFingerprint, SPAWN_DEDUPE_WINDOW_SECONDS } from './spawn-idempotency.js';
import type { SpawnRequest } from './spawn-rpc.js';

const base: SpawnRequest = {
  parentSessionId: 'parent-a',
  parentUserId: 1,
  name: 'Handoff — Runtime Box patch',
  prompt: 'Implement the patch.',
  contextSummary: 'Continue from diagnosis.',
  onComplete: { mode: 'inject-and-wake' },
};

describe('spawn request idempotency', () => {
  it('gives an exact retry the same fingerprint even when caller identity differs', () => {
    expect(buildSpawnRequestFingerprint(base)).toBe(buildSpawnRequestFingerprint({
      ...base,
      parentSessionId: 'parent-b',
      parentUserId: 99,
    }));
  });

  it('normalizes harmless surrounding whitespace and CRLF', () => {
    expect(buildSpawnRequestFingerprint(base)).toBe(buildSpawnRequestFingerprint({
      ...base,
      name: `  ${base.name}  `,
      prompt: 'Implement the patch.\r\n',
    }));
  });

  it('keeps intentional separate work distinct', () => {
    expect(buildSpawnRequestFingerprint(base)).not.toBe(buildSpawnRequestFingerprint({
      ...base,
      prompt: 'Review the patch instead.',
    }));
    expect(buildSpawnRequestFingerprint(base)).not.toBe(buildSpawnRequestFingerprint({
      ...base,
      onComplete: { mode: 'inject-only' },
    }));
    expect(buildSpawnRequestFingerprint(base)).not.toBe(buildSpawnRequestFingerprint({
      ...base,
      effort: 'high',
      modelPolicyId: 'high',
      modelPolicyRevision: 1,
    }));
  });

  it('uses a bounded retry window so a later intentional repeat remains possible', () => {
    expect(SPAWN_DEDUPE_WINDOW_SECONDS).toBe(120);
  });
});
