import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.resolve(import.meta.dirname, relative), 'utf8');
const taskRunner = read('../task/task-runner.ts');
const proactiveAgent = read('../ai/proactive-agent.ts');
const piRuntime = read('../ai/pi-session-runtime.ts');
const piEngine = read('../../engines/pi-engine.ts');
const backendIndex = read('../../index.ts');

describe('Pi root-turn identity entrypoints', () => {
  it('binds task and proactive runs to their persisted user messages', () => {
    expect(taskRunner).toMatch(/const rootTurnId = uuidv4\(\);[\s\S]*id: rootTurnId,[\s\S]*rootTurnId,/);
    expect(proactiveAgent).toMatch(/const rootTurnId = uuidv4\(\);[\s\S]*id: rootTurnId,[\s\S]*rootTurnId,/);
  });

  it('persists root identity in the Pi shutdown handoff and restores it at startup', () => {
    expect(piRuntime).toContain('export type InterruptedPiSession = { id: string; rootTurnId?: string }');
    expect(piEngine).toContain('getCurrentRootTurn(sessionId)');
    expect(piEngine).toContain("({ id: sessionId, rootTurnId })");
    expect(backendIndex).toContain('consumeInterruptedPiSessionDetails()');
    expect(backendIndex).toContain('userMessageId: session.rootTurnId');
  });
});
