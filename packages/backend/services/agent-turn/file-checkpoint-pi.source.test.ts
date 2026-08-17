import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const engine = fs.readFileSync(path.resolve(import.meta.dirname, '../../engines/pi-engine.ts'), 'utf8');

describe('Pi file checkpoint lifecycle source contract', () => {
  it('captures write/edit before execution and completes after terminal event', () => {
    expect(engine).toContain('beginCheckpointForTool(event)');
    expect(engine).toContain('completeCheckpointForTool(event)');
    expect(engine).toMatch(/case 'tool_execution_start'[\s\S]*beginCheckpointForTool\(event\)[\s\S]*enterToolRunningPhase/);
    expect(engine).toMatch(/case 'tool_execution_end'[\s\S]*completeCheckpointForTool\(event\)[\s\S]*handlePiToolExecutionEnd/);
    expect(engine).toContain("toolName === 'write' || toolName === 'edit'");
  });

  it('marks project shell mutations partial and keeps capture fail-soft', () => {
    expect(engine).toContain("toolName === 'project_shell' || toolName === 'bash'");
    expect(engine).toContain('markTurnCheckpointPartial(checkpointContext)');
    expect(engine).toContain('[checkpoint] before capture failed');
    expect(engine).toContain('[checkpoint] after capture failed');
  });
});
