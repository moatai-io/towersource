import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const safeguards = fs.readFileSync(path.resolve(import.meta.dirname, './pi/provider-safeguards.ts'), 'utf8');
const engine = fs.readFileSync(path.resolve(import.meta.dirname, './pi-engine.ts'), 'utf8');

describe('LiteLLM correlation metadata contract', () => {
  it('adds Project and execution attribution without replacing existing client metadata', () => {
    expect(safeguards).toContain('...current');
    expect(safeguards).toContain('tower_project_id: ctx.projectId');
    expect(safeguards).toContain('tower_execution_kind: ctx.executionKind');
    expect(safeguards).toContain('tower_root_turn_id: ctx.rootTurnId');
    expect(safeguards).toContain('tower_session_id: ctx.sessionId');
    expect(engine).toContain('projectId: opts.projectId');
  });
});
