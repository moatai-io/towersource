import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Pi immediate steering integration wiring', () => {
  const engine = readFileSync(new URL('../pi-engine.ts', import.meta.url), 'utf8');
  it('queues durable steering before interrupting and excludes intentional abort errors', () => {
    const steer = engine.slice(engine.indexOf('  async steer('), engine.indexOf('  async cancelSteer('));
    expect(steer.indexOf('await entry.session.steer(message)')).toBeLessThan(steer.indexOf('entry.immediateSteering?.request('));
    expect(engine).toContain('analysis.providerErrorText && !immediateSteering.interrupting');
    expect(engine).toContain('if (immediateSteering.interrupting && !entry.abortRequested && !entry.safeStopRequested) break;');
  });
  it('wraps initial prompts and native recovery while tracking tool boundaries', () => {
    expect(engine.match(/immediateSteering.run\(/g)).toHaveLength(2);
    expect(engine).toContain('immediateSteering.toolStarted();');
    expect(engine).toContain('immediateSteering.toolEnded();');
  });
});
