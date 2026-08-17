import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('packages/backend/index.ts'), 'utf8');

describe('candidate backend passive mode', () => {
  it('does not consume primary shutdown handoff files', () => {
    expect(source).toContain("process.env.TOWER_CANDIDATE_PASSIVE_MODE === 'true'");
    expect(source).toMatch(/candidatePassiveMode \? \[\] : consumeInterruptedSessions\(\)/);
    expect(source).toMatch(/candidatePassiveMode \? \[\] : consumeInterruptedPiSessionDetails\(\)/);
    expect(source).toMatch(/if \(!candidatePassiveMode\) \{[\s\S]*?findOrphanedStartedAgentTurns/);
  });

  it('gates shared-database background mutators and automatic recovery', () => {
    expect(source).toMatch(/if \(!candidatePassiveMode\) \{[\s\S]*?startUnifiedScheduler/);
    expect(source).toMatch(/if \(!candidatePassiveMode\) \{[\s\S]*?initProactiveAgent/);
    expect(source).toMatch(/if \(!candidatePassiveMode\) \{[\s\S]*?recoverRunningAgentRunsOnStartup/);
    expect(source).toMatch(/if \(!candidatePassiveMode\) \{[\s\S]*?startAgentRunSettlementRecovery\(\)/);
    expect(source).toMatch(/if \(!candidatePassiveMode\) \{[\s\S]*?startAgentTurnDispatcher/);
    expect(source).toMatch(/if \(!candidatePassiveMode\) \{[\s\S]*?serverSideResumeInterrupted/);
    expect(source).toContain('stopAgentTurnDispatcher()');
    expect(source).toContain('stopAgentRunSettlementRecovery()');
    expect(source).toContain('!candidatePassiveMode && process.env.ENABLE_SANDBOX');
    expect(source).toContain('!candidatePassiveMode && config.runtimeBox.enabled');
  });
});
