import { describe, expect, it } from 'vitest';
import { shouldGuardSideEffectTool } from './side-effect-tool-wrapper.js';

const read = { actionClass: 'read', reason: 'test' } as const;
const write = { actionClass: 'write', reason: 'test' } as const;

describe('side effect tool guard scope', () => {
  it('leaves known read-only tools and read-only shell commands unguarded', () => {
    expect(shouldGuardSideEffectTool('read', read)).toBe(false);
    expect(shouldGuardSideEffectTool('WebSearch', read)).toBe(false);
    expect(shouldGuardSideEffectTool('bash', read)).toBe(false);
  });

  it('guards durable writes, orchestration and unknown custom tools', () => {
    expect(shouldGuardSideEffectTool('write', write)).toBe(true);
    expect(shouldGuardSideEffectTool('publish_site', { actionClass: 'deploy', reason: 'test' })).toBe(true);
    expect(shouldGuardSideEffectTool('mcp__schedule__create_ai_schedule', { actionClass: 'credential-admin', reason: 'test' })).toBe(true);
    expect(shouldGuardSideEffectTool('unknown_custom_mcp', read)).toBe(true);
  });

  it('does not ledger conversational checkpoints that are intentionally repeatable', () => {
    expect(shouldGuardSideEffectTool('AskUserQuestion', write)).toBe(false);
    expect(shouldGuardSideEffectTool('TodoWrite', write)).toBe(false);
  });
});
