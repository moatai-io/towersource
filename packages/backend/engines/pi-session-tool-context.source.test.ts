import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const engine = readFileSync(new URL('./pi-engine.ts', import.meta.url), 'utf8');
const entry = readFileSync(new URL('./pi/session-entry.ts', import.meta.url), 'utf8');

describe('Pi cached tool authority context', () => {
  it('records the authority used to assemble closure-bound tools', () => {
    expect(entry).toContain('toolContext?:');
    expect(engine).toContain('toolContext: {');
    expect(engine).toContain('userId: opts.userId');
    expect(engine).toContain('userRole: opts.userRole');
    expect(engine).toContain('projectId: opts.projectId');
    expect(engine).toContain('workbenchRolloutEnabled: opts.projectId');
  });

  it('rebuilds a cached SDK Session before a turn when authority or Workbench rollout changes', () => {
    expect(engine).toContain('entry.toolContext?.userId !== opts.userId');
    expect(engine).toContain('entry.toolContext?.userRole !== opts.userRole');
    expect(engine).toContain('entry.toolContext?.projectId !== opts.projectId');
    expect(engine).toContain('entry.toolContext?.workbenchRolloutEnabled !== workbenchRolloutEnabled');
    expect(engine).toContain('await resolveWorkbenchRollout(opts.projectId)');
    expect(engine).toContain('this.dispose(sessionId);');
  });
});
