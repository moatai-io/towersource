import { describe, expect, it } from 'vitest';
import { classifyVoiceOwner } from './voice-admission-state.js';
const base = { state: 'running', has_owner: true, lease_until: new Date(2000).toISOString(), waiting_user: false, last_failure_class: null };
describe('voice BUSY versus recovery boundary', () => {
  it('keeps live ownership retryable but never interprets missing evidence as idle', () => {
    expect(classifyVoiceOwner(base, 1000)).toBe('VOICE_BUSY');
    expect(classifyVoiceOwner(undefined, 1000)).toBe('VOICE_BUSY');
  });
  it('makes abandoned/waiting-retry/expired lease/approval waits nonretryable without modifying roots', () => {
    for (const patch of [{ state: 'waiting_retry', has_owner: false }, { last_failure_class: 'abandoned_owner' }, { waiting_user: true }, { lease_until: new Date(500).toISOString() }]) {
      expect(classifyVoiceOwner({ ...base, ...patch }, 1000)).toBe('VOICE_RECOVERY_REQUIRED');
    }
  });
});
