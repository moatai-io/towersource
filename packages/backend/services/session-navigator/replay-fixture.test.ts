import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSessionNavigatorReplayFixtures } from './replay-fixture.js';

const fixtures = parseSessionNavigatorReplayFixtures(JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/phase-0-replays.json', import.meta.url)),
  'utf8',
)));

describe('Session Navigator Phase 0 replay fixtures', () => {
  it('contains at least 30 sanitized, schema-valid cases', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
  });

  it('covers every continuity and safety boundary category', () => {
    expect(new Set(fixtures.map((fixture) => fixture.category))).toEqual(new Set([
      'preserved',
      'goal_shifted',
      'constraint_lost',
      'decision_lost',
      'commitment_lost',
      'unresolved_work_lost',
      'needs_source_check',
      'approval_boundary',
      'stale_revision',
      'provider_failure',
    ]));
  });

  it('never treats shadow replay output as permission to auto-execute', () => {
    expect(fixtures.every((fixture) => fixture.expected.autoExecutionAllowed === false)).toBe(true);
    expect(fixtures.filter((fixture) => fixture.candidateAction.risk === 'approval_required').every(
      (fixture) => fixture.expected.turnEndDecision === 'stop_for_human',
    )).toBe(true);
  });

  it('rejects stale revisions and provider failures through expected inspection paths', () => {
    const stale = fixtures.filter((fixture) => fixture.category === 'stale_revision');
    expect(stale.every((fixture) => fixture.candidateAction.contextRevision !== fixture.currentContextRevision)).toBe(true);
    expect(stale.every((fixture) => fixture.expected.turnEndDecision === 'inspect')).toBe(true);

    const failures = fixtures.filter((fixture) => fixture.category === 'provider_failure');
    expect(failures.every((fixture) => fixture.providerStatus !== 'available')).toBe(true);
    expect(failures.every((fixture) => fixture.expected.needsHistoricalSource)).toBe(true);
  });

  it('runs the detailed diagnostic only for inspect or semantic-loss signals', () => {
    const ordinaryPreserved = fixtures.filter((fixture) => fixture.category === 'preserved');
    expect(ordinaryPreserved.every((fixture) => fixture.expected.turnEndDecision === 'continue')).toBe(true);
    expect(ordinaryPreserved.every((fixture) => !fixture.expected.continuityDiagnosticRequired)).toBe(true);
    expect(fixtures.filter((fixture) => fixture.expected.turnEndDecision === 'inspect').every(
      (fixture) => fixture.expected.continuityDiagnosticRequired,
    )).toBe(true);
  });

  it('keeps delegated provenance distinct from human response provenance', () => {
    const sources = new Set(fixtures.map((fixture) => fixture.candidateAction.source));
    expect(sources).toEqual(new Set(['jev_auto']));
    expect(sources.has('user_click')).toBe(false);
  });
});
