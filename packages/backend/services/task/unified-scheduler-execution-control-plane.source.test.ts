import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/task/unified-scheduler.ts'), 'utf8');

describe('scheduled Automation Execution Control Plane wiring', () => {
  it('uses the persisted due occurrence as deterministic schedule identity', () => {
    expect(source).toContain('const dueAt = automation.nextRunAt');
    expect(source).toContain('automation:${automation.id}:schedule:${new Date(String(dueAt)).toISOString()}');
    expect(source).toContain("trigger: 'schedule'");
  });

  it('does not create a second legacy Automation Run for the new path', () => {
    expect(source).toContain('const runId = executionResult ? executionResult.automationRunId : await logAutoRun');
    expect(source).toContain('runId: executionResult.automationRunId');
    expect(source).toContain('executionId: executionResult.executionId');
  });

  it('does not duplicate legacy failure rows or terminal side effects for replayed occurrences', () => {
    const guard = source.indexOf("if (pathDecision.path === 'execution_control_plane') {");
    const legacyFailure = source.indexOf('await logAutoRun({', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(source.slice(guard, legacyFailure)).toContain('continue;');
    expect(source).toContain('executionResult && !executionResult.replayedOccurrence');
    expect(source).toContain("result.status !== 'spawned' && result.status !== 'none' && !executionResult?.replayedOccurrence");
  });

  it('advances the schedule only after the shared orchestrator returns a terminal result', () => {
    const executeAt = source.indexOf('await executeAutomationViaExecutionControlPlane');
    const advanceAt = source.indexOf('await advanceAuto(automation, result.status', executeAt);
    expect(executeAt).toBeGreaterThan(-1);
    expect(advanceAt).toBeGreaterThan(executeAt);
  });
});
