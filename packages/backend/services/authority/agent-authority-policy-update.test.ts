import { describe, expect, it } from 'vitest';
import { assertOrdinaryAgentCreationAuthority, preserveAgentExecutionAuthority } from './agent-authority-policy-update.js';
describe('reserved Agent execution policy', () => {
  it.each([{}, { superuser: false }])('treats absent superuser as inactive: %j', current => {
    expect(() => preserveAgentExecutionAuthority(current, { superuser: true })).toThrow('AGENT_EXECUTION_AUTHORITY_RESERVED');
  });
  it('preserves active binding even when an ordinary replacement omits the key', () => {
    expect(preserveAgentExecutionAuthority({ superuser: true }, { arbitraryBusinessPolicy: 'editable' }))
      .toEqual({ superuser: true, arbitraryBusinessPolicy: 'editable' });
    expect(() => preserveAgentExecutionAuthority({ superuser: true }, { superuser: false })).toThrow('RESERVED');
  });
  it('accepts unchanged values without adding a missing platform key', () => {
    expect(preserveAgentExecutionAuthority({}, { superuser: false, approval: 'ask' })).toEqual({ approval: 'ask' });
    expect(preserveAgentExecutionAuthority({ superuser: true }, { superuser: true })).toEqual({ superuser: true });
  });
  it.each([true, 'true', 1, null, {}, []])('rejects creation platform payload %j', superuser => {
    expect(() => assertOrdinaryAgentCreationAuthority({ superuser })).toThrow('RESERVED');
  });
  it('allows ordinary creation settings without changing payload/hash material', () => {
    const policy = { superuser: false, destructiveActions: 'confirm' };
    assertOrdinaryAgentCreationAuthority(policy);
    expect(policy).toEqual({ superuser: false, destructiveActions: 'confirm' });
    expect(() => assertOrdinaryAgentCreationAuthority()).not.toThrow();
  });
});
