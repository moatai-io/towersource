import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Engine Contract Compliance Tests
 *
 * Verifies that BOTH engines (Claude + Pi) honor the same TowerMessage contract.
 * These are source-level contract tests — they read the actual engine code
 * and verify structural compliance without needing a running server.
 *
 * See: docs/plans/2026-04-03-engine-contract-normalization.md
 */

const CLAUDE_ENGINE = path.resolve(import.meta.dirname, '../claude-engine.ts');
const PI_ENGINE = path.resolve(import.meta.dirname, '../pi-engine.ts');
const PI_TOOL_ASSEMBLY = path.resolve(import.meta.dirname, '../pi/tool-assembly.ts');
const PI_RUN_TERMINALIZER = path.resolve(import.meta.dirname, '../pi/run-terminalizer.ts');
const PI_RUN_CONTEXT = path.resolve(import.meta.dirname, '../pi/run-context.ts');
const TYPES = path.resolve(import.meta.dirname, '../types.ts');

function readSource(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

describe('Engine Contract — TowerUsage documentation', () => {
  it('types.ts documents REQUIRED/RECOMMENDED/OPTIONAL fields', () => {
    const src = readSource(TYPES);
    expect(src).toMatch(/REQUIRED.*all engines must provide/i);
    expect(src).toMatch(/RECOMMENDED.*all engines should provide/i);
    expect(src).toMatch(/OPTIONAL.*engine-specific/i);
  });

  it('types.ts has engine comparison table', () => {
    const src = readSource(TYPES);
    expect(src).toMatch(/Claude.*Pi/);
    expect(src).toMatch(/inputTokens.*REQUIRED/i);
  });
});

describe('Engine Contract — both engines yield engine_done', () => {
  for (const [name, file] of [['Claude', CLAUDE_ENGINE], ['Pi', PI_ENGINE]]) {
    it(`${name} engine yields engine_done with engineSessionId`, () => {
      const src = readSource(file);
      expect(src).toMatch(/type:\s*['"]engine_done['"]/);
      expect(src).toMatch(/engineSessionId/);
    });
  }
});

describe('Engine Contract — both engines yield turn_done with required fields', () => {
  for (const [name, file] of [['Claude', CLAUDE_ENGINE], ['Pi', PI_ENGINE]]) {
    it(`${name} engine yields turn_done with inputTokens + outputTokens + durationMs`, () => {
      // Pi moved turn_done emission behind run-terminalizer. Inspect the composed
      // execution path rather than only the top-level pi-engine facade.
      const src = name === 'Pi'
        ? `${readSource(file)}\n${readSource(PI_RUN_TERMINALIZER)}\n${readSource(PI_RUN_CONTEXT)}`
        : readSource(file);
      // Must have a turn_done message with usage
      expect(src).toMatch(/type:\s*['"]turn_done['"]/);
      expect(src).toMatch(/inputTokens/);
      expect(src).toMatch(/outputTokens/);
      expect(src).toMatch(/durationMs/);
    });

    it(`${name} engine includes context metrics in turn_done`, () => {
      // Pi moved turn_done usage construction behind run-terminalizer/run-context.
      // Keep this contract test pointed at the actual execution path, not only the
      // top-level pi-engine facade.
      const src = name === 'Pi'
        ? `${readSource(file)}\n${readSource(PI_RUN_TERMINALIZER)}\n${readSource(PI_RUN_CONTEXT)}`
        : readSource(file);
      expect(src).toMatch(/contextInputTokens/);
      expect(src).toMatch(/contextWindowSize/);
      expect(src).toMatch(/numIterations/);
    });
  }
});

describe('Engine Contract — both engines handle abort gracefully', () => {
  for (const [name, file] of [['Claude', CLAUDE_ENGINE], ['Pi', PI_ENGINE]]) {
    it(`${name} engine suppresses engine_error on user abort`, () => {
      const src = readSource(file);
      // Should check for abort and NOT yield error
      expect(src).toMatch(/abort/i);
      expect(src).toMatch(/isAbort/i);
    });
  }
});

describe('Engine Contract — both engines call EngineCallbacks', () => {
  for (const [name, file] of [['Claude', CLAUDE_ENGINE], ['Pi', PI_ENGINE]]) {
    it(`${name} engine calls callbacks.saveMessage`, () => {
      const src = readSource(file);
      expect(src).toMatch(/callbacks\.saveMessage/);
    });

    it(`${name} engine calls callbacks.updateMessageContent`, () => {
      const src = readSource(file);
      expect(src).toMatch(/callbacks\.updateMessageContent/);
    });

    it(`${name} engine calls callbacks.attachToolResult`, () => {
      const src = readSource(file);
      expect(src).toMatch(/callbacks\.attachToolResult/);
    });

    it(`${name} engine calls callbacks.claimSessionId`, () => {
      const src = readSource(file);
      expect(src).toMatch(/callbacks\.claimSessionId/);
    });

    it(`${name} engine calls callbacks.updateMessageMetrics`, () => {
      const src = readSource(file);
      expect(src).toMatch(/callbacks\.updateMessageMetrics/);
    });
  }
});

describe('Engine Contract — resume failure handling', () => {
  it('Claude engine yields engine_error(recoverable) on resume failure', () => {
    const src = readSource(CLAUDE_ENGINE);
    expect(src).toMatch(/resume_failed/i);
    expect(src).toMatch(/recoverable:\s*true/);
  });

  it('Pi engine yields engine_error(recoverable) on resume failure', () => {
    const src = readSource(PI_ENGINE);
    expect(src).toMatch(/resumeFailedMessage/);
    expect(src).toMatch(/recoverable:\s*true/);
  });

  it('neither engine clears session ID on error (preserves recovery path)', () => {
    const claudeSrc = readSource(CLAUDE_ENGINE);
    const piSrc = readSource(PI_ENGINE);
    // Session ID should NEVER be cleared — clearing causes permanent context loss
    expect(claudeSrc).not.toMatch(/claimSessionId\(''\)/);
    expect(piSrc).not.toMatch(/claimSessionId\(''\)/);
  });
});

describe('Engine Contract — tool guard integration', () => {
  for (const [name, file] of [['Claude', CLAUDE_ENGINE], ['Pi', PI_TOOL_ASSEMBLY]]) {
    it(`${name} engine path uses buildToolGuard`, () => {
      const src = readSource(file);
      expect(src).toMatch(/buildToolGuard/);
    });
  }
});

// ─── Session-scope wiring (regression: 2026-04-18 tower-brain incident) ─────
// The session-scoped write guard is only effective if every entry point that
// constructs a ToolGuard derives `sessionProjectRoot` from the runtime cwd.
// These are source-level checks — if anyone removes the wiring we hear about
// it in CI before an orphan folder shows up in production.
//
// See: workspace/decisions/2026-04-18-session-scoped-write-guard.md
// Tag:  path-guard, safety, P2, regression

describe('Engine Contract — sessionProjectRoot wiring (tower-brain regression)', () => {
  const TASK_RUNNER = path.resolve(import.meta.dirname, '../../services/task/task-runner.ts');

  const guardConsumers: [string, string][] = [
    ['Claude engine', CLAUDE_ENGINE],
    ['Pi tool assembly', PI_TOOL_ASSEMBLY],
    ['task-runner', TASK_RUNNER],
  ];

  for (const [name, file] of guardConsumers) {
    it(`${name} resolves sessionProjectRoot from cwd`, () => {
      const src = readSource(file);
      // Either resolveSessionProjectRoot(opts.cwd) or resolveSessionProjectRoot(agentCwd) —
      // accept any identifier but require the call itself.
      expect(src).toMatch(/resolveSessionProjectRoot\s*\(/);
    });

    it(`${name} passes sessionProjectRoot into buildToolGuard`, () => {
      const src = readSource(file);
      // Find the buildToolGuard call and verify sessionProjectRoot is one of its opts.
      // Span up to ~500 chars to cover multi-line object literals.
      const match = src.match(/buildToolGuard\s*\(\s*\{[\s\S]{0,500}?\}\s*\)/);
      expect(match, `${name} should build ToolGuard with an options object`).not.toBeNull();
      expect(match![0]).toMatch(/sessionProjectRoot\s*[:,}]/);
    });
  }


  it('system-prompt keeps either explicit or server-enforced current project boundary guidance', () => {
    const SYSTEM_PROMPT = path.resolve(import.meta.dirname, '../../services/system-prompt.ts');
    const src = readSource(SYSTEM_PROMPT);
    // Both the committed prompt and the in-flight compact prompt preserve a clear current-project boundary.
    expect(src).toMatch(/Current project boundary|current Project as the default boundary/);
    expect(src).toMatch(/sessionProjectRoot/);
  });

  it('project-access exports resolveSessionProjectRoot + buildSessionWriteGuard + buildToolGuard', () => {
    const PROJECT_ACCESS = path.resolve(import.meta.dirname, '../../services/pm/project-access.ts');
    const src = readSource(PROJECT_ACCESS);
    expect(src).toMatch(/export function resolveSessionProjectRoot/);
    expect(src).toMatch(/export function buildSessionWriteGuard/);
    expect(src).toMatch(/export function buildToolGuard/);
  });
});
