import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8');
describe('sleep runtime wiring', () => {
  it('mounts the native Pi tool only on the existing non-restricted surface', () => {
    const source = read('pi/tool-assembly.ts');
    expect(source).toContain('createSleepTool({ sessionId, rootTurnId: opts.rootTurnId })');
    expect(source.indexOf('Restricted Harness tools:')).toBeLessThan(source.indexOf('createSleepTool({'));
  });
  it('mounts Claude MCP with the live SDK AbortSignal and allows its bounded hard timeout', () => {
    expect(read('claude-engine.ts')).toContain('wait: createSleepMcpServer({ sessionId, rootTurnId: opts.rootTurnId, getSignal: () => getSessionAbortSignal(sessionId) })');
    const sdk = read('../services/ai/claude-sdk.ts');
    expect(sdk).toContain('injectedEnv.MCP_TOOL_TIMEOUT');
    expect(sdk).toContain('nextClaudeMessageWithSleep(iterator.next(), timeoutMs, () => isSessionSleeping(sessionId), phase)');
  });
  it('fences sleep before generic startup recovery and cancels Pi safe stop promptly', () => {
    const boot = read('../index.ts');
    expect(boot.indexOf('await interruptRestartedSleepTurns()')).toBeLessThan(boot.indexOf('await interruptRestartedWaitingUserTurns()'));
    const engine = read('pi-engine.ts');
    const stop = engine.slice(engine.indexOf('async requestStopAtBoundary'), engine.indexOf('async steer('));
    expect(stop).toContain('cancelSessionSleep(sessionId)');
  });
});
