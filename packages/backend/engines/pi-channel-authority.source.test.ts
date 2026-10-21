import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const assembly = readFileSync(new URL('./pi/tool-assembly.ts', import.meta.url), 'utf8');
const engine = readFileSync(new URL('./pi-engine.ts', import.meta.url), 'utf8');
describe('Channel authority wiring regression', () => {
  it('denies operator access before reading project policy', () => {
    const resolver = assembly.slice(assembly.indexOf('export async function resolveOperatorHostAccess'), assembly.indexOf('export async function buildPiToolAssembly'));
    expect(resolver.indexOf('if (input.channelSafeToolsOnly) return false;')).toBeGreaterThan(-1);
    expect(resolver.indexOf('if (input.channelSafeToolsOnly) return false;')).toBeLessThan(resolver.indexOf('await getProjectAgentRuntimeProfile'));
  });
  it('passes channel restriction to assembly, cached turn and compact checks', () => {
    const call = 'resolveOperatorHostAccess({ projectId: opts.projectId, userRole: opts.userRole, channelSafeToolsOnly: opts.channelSafeToolsOnly })';
    expect(assembly).toContain(call);
    expect(engine.split(call)).toHaveLength(3);
  });
});
