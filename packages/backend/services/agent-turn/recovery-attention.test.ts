import { describe, expect, it } from 'vitest';
import { projectRecoveryAttention } from './recovery-attention.js';

describe('recovery attention projection', () => {
  it('retires superseded recovery without actionable error regardless of diagnostic wording', () => {
    for (const message of ['Automatic recovery skipped because a newer user turn exists in this session.', 'changed diagnostic', null]) {
      expect(projectRecoveryAttention('needs_attention', 'restart_recovery_superseded', message)).toMatchObject({ state: 'needs_attention', lastError: message, requiresAttention: false, recoveryDisposition: 'superseded' });
    }
  });
  it.each(['restart_recovery_stale', 'restart_recovery_limit', 'other', null])('preserves actionable attention: %s', reason => {
    expect(projectRecoveryAttention('needs_attention', reason, 'failure')).toMatchObject({ state: 'needs_attention', lastError: 'failure', requiresAttention: true, recoveryDisposition: null });
  });
  it('does not suppress running or actual failed turns', () => {
    for (const state of ['running', 'failed'] as const) expect(projectRecoveryAttention(state, 'restart_recovery_superseded', 'failure')).toMatchObject({ state, lastError: 'failure', recoveryDisposition: null });
  });
});
