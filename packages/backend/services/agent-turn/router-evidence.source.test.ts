import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const provider = fs.readFileSync(path.resolve(import.meta.dirname, '../../engines/pi/provider-safeguards.ts'), 'utf8');
const engine = fs.readFileSync(path.resolve(import.meta.dirname, '../../engines/pi-engine.ts'), 'utf8');

describe('Pi Router evidence wiring', () => {
  it('propagates opaque Tower correlation through LiteLLM Responses metadata', () => {
    expect(engine).toContain('rootTurnId: opts.rootTurnId');
    expect(engine).toContain('attempt: initialRecoveryClaimAttempt');
    expect(provider).toContain('tower_root_turn_id: ctx.rootTurnId');
    expect(provider).toContain('tower_attempt: ctx.attempt ?? 0');
    expect(provider).toContain('captureLiteLLMRouterEvidence');
  });

  it('records terminal evidence without changing Tower turn state', () => {
    expect(provider).toContain("value === 'response.completed'");
    expect(provider).toContain("'transport_closed_without_terminal'");
    expect(provider).toContain('recordAgentTurnRouterEvidence');
    expect(provider).not.toContain('updateUnclaimedAgentTurn');
    expect(provider).not.toContain('settleAgentTurn');
  });
});
