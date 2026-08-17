import { describe, it, expect } from 'vitest';
import { diffConsumedSteers } from './pi-steer-tracker.js';

describe('diffConsumedSteers', () => {
  it('detects nothing when a steer is newly added (present in current only)', () => {
    // steer() just queued "hello" — queue_update goes [] -> ["hello"]
    expect(diffConsumedSteers([], ['hello'])).toEqual([]);
  });

  it('detects a single steer consumed (present -> absent)', () => {
    // agent picked it up — queue_update goes ["hello"] -> []
    expect(diffConsumedSteers(['hello'], [])).toEqual(['hello']);
  });

  it('keeps a steer pending while it is still in the queue', () => {
    expect(diffConsumedSteers(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('detects only the consumed one when multiple are pending', () => {
    // "a" consumed first, "b" still pending
    expect(diffConsumedSteers(['a', 'b'], ['b'])).toEqual(['a']);
  });

  it('handles duplicate steer texts by count (one of two consumed)', () => {
    expect(diffConsumedSteers(['dup', 'dup'], ['dup'])).toEqual(['dup']);
  });

  it('handles duplicate steer texts by count (both consumed)', () => {
    expect(diffConsumedSteers(['dup', 'dup'], [])).toEqual(['dup', 'dup']);
  });

  it('detects multiple distinct consumed at once', () => {
    expect(diffConsumedSteers(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('returns empty for two empty snapshots', () => {
    expect(diffConsumedSteers([], [])).toEqual([]);
  });

  it('ignores texts that appear only in current (not previously tracked)', () => {
    // a brand-new steer added in the same update that consumed an old one
    expect(diffConsumedSteers(['old'], ['new'])).toEqual(['old']);
  });
});
