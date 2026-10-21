import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const engine = fs.readFileSync(path.resolve(import.meta.dirname, './pi-engine.ts'), 'utf8');
const types = fs.readFileSync(path.resolve(import.meta.dirname, './types.ts'), 'utf8');
const ws = fs.readFileSync(path.resolve(import.meta.dirname, '../routes/ws-handler.ts'), 'utf8');
const supervisor = fs.readFileSync(path.resolve(import.meta.dirname, '../services/agent-turn/turn-supervisor.ts'), 'utf8');

describe('Pi safe stop contract', () => {
  it('waits for an active tool boundary before aborting the SDK loop', () => {
    expect(types).toContain('requestStopAtBoundary?');
    expect(engine).toContain('safeStopRequested');
    expect(engine).toContain('classifyPiSafeStopRequest');
    expect(engine).toContain('shouldStopPiAtToolBoundary');
    expect(engine).toContain("markClosing('safe-stop-boundary', 'aborted')");
    expect(engine).toMatch(/leaveToolRunningPhase[\s\S]*safeStopRequested[\s\S]*entry\.session\.abort/);
  });

  it('treats Workbench foreground work as the active Pi tool and leaves detached services outside stop authority', () => {
    const runtimeTools = fs.readFileSync(path.resolve(import.meta.dirname, './pi-runtime-box-tools.ts'), 'utf8');

    expect(engine).toContain("case 'tool_execution_start'");
    expect(engine).toContain("case 'tool_execution_end'");
    expect(engine).toMatch(/case 'tool_execution_start'[\s\S]*enterToolRunningPhase/);
    expect(engine).toMatch(/case 'tool_execution_end'[\s\S]*leaveToolRunningPhase/);
    expect(runtimeTools).toContain('execInBox');
    expect(runtimeTools).toContain("name: 'service_start'");
    expect(engine).not.toContain('stopRuntimeBoxService');
  });

  it('force stop aborts immediately without requiring durable turn bookkeeping', () => {
    const handlerStart = ws.indexOf('async function handleTurnStopRequest');
    const handlerEnd = ws.indexOf('\nasync function handleAbort', handlerStart);
    const handler = ws.slice(handlerStart, handlerEnd);
    const forceStart = handler.indexOf("if (mode === 'force')");
    const missingTurnGuard = handler.indexOf('if (!rootTurnId)');

    expect(handler).toContain("mode === 'force'");
    expect(handler).toContain('abortSessionEverywhere(sessionId)');
    expect(handler).toContain("settleAgentTurnStop({ rootTurnId, mode: 'force' })");
    expect(handler).toContain("data: { type: 'abort_session_sync' }");
    expect(handler).toContain("state: 'stopped_forced'");
    expect(forceStart).toBeGreaterThanOrEqual(0);
    expect(forceStart).toBeLessThan(missingTurnGuard);
    expect(forceStart).toBeLessThan(handler.indexOf('requestAgentTurnStop'));
    expect(forceStart).toBeLessThan(handler.indexOf('engine.requestStopAtBoundary'));
  });

  it('persists and broadcasts requested and terminal stop states', () => {
    expect(ws).toContain("case 'request_turn_stop'");
    expect(ws).toContain('requestAgentTurnStop');
    expect(ws).toContain('settleAgentTurnStop');
    expect(ws).toContain("state: 'boundary_wait'");
    expect(ws).toContain("'stopped_clean'");
    expect(supervisor).toContain("state = 'stop_requested'");
    expect(supervisor).toContain('rejectAgentTurnStopRequest');
    expect(supervisor).toContain("SET state = 'running', stop_mode = NULL");
    expect(supervisor).toContain("'stopped_forced'");
  });
});
