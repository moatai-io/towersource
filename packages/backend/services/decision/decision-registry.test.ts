import { describe, expect, it } from 'vitest';
import { TOWER_REQUEST_ROUTING_SPEC } from './examples.js';
import { DecisionSpecRegistry } from './decision-registry.js';

describe('DecisionSpecRegistry', () => {
  it('registers validated immutable revisions and resolves latest by default', () => {
    const registry = new DecisionSpecRegistry();
    const first = registry.register(TOWER_REQUEST_ROUTING_SPEC);
    const second = registry.register({ ...TOWER_REQUEST_ROUTING_SPEC, revision: 2 });
    expect(registry.get('tower.request-routing')).toBe(second);
    expect(registry.get('tower.request-routing', 1)).toBe(first);
    expect(registry.list().map((spec) => spec.revision)).toEqual([1, 2]);
    expect(() => { (second as any).purpose = 'mutated'; }).toThrow();
  });

  it('rejects duplicate and non-increasing revisions', () => {
    const registry = new DecisionSpecRegistry();
    registry.register(TOWER_REQUEST_ROUTING_SPEC);
    expect(() => registry.register(TOWER_REQUEST_ROUTING_SPEC)).toThrow('already registered');
    registry.register({ ...TOWER_REQUEST_ROUTING_SPEC, revision: 2 });
    expect(() => registry.register({ ...TOWER_REQUEST_ROUTING_SPEC, revision: 1 })).toThrow('must increase');
    expect(() => registry.get('unknown')).toThrow('not found');
  });

  it('validates before registration', () => {
    const registry = new DecisionSpecRegistry();
    expect(() => registry.register({ ...TOWER_REQUEST_ROUTING_SPEC, mode: 'live' })).toThrow();
    expect(registry.list()).toHaveLength(0);
  });
});
