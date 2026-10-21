import { parseDecisionSpec, type DecisionSpec } from './decision-spec.js';

export class DecisionSpecRegistryError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'DecisionSpecRegistryError'; }
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  }
  return value;
}

/** Process-local registry; persistence and project ACL binding are intentionally separate concerns. */
export class DecisionSpecRegistry {
  private readonly specs = new Map<string, DecisionSpec>();

  register(input: unknown): DecisionSpec {
    const spec = parseDecisionSpec(input);
    const key = `${spec.id}@${spec.revision}`;
    const latest = [...this.specs.values()].filter((candidate) => candidate.id === spec.id).sort((a, b) => b.revision - a.revision)[0];
    if (latest && spec.revision <= latest.revision) {
      const code = spec.revision === latest.revision ? 'DECISION_SPEC_DUPLICATE' : 'DECISION_SPEC_REVISION';
      const message = spec.revision === latest.revision ? `DecisionSpec already registered: ${key}` : `DecisionSpec revision must increase: ${spec.id}`;
      throw new DecisionSpecRegistryError(message, code);
    }
    const stored = immutable(structuredClone(spec));
    this.specs.set(key, stored);
    return stored;
  }

  get(id: string, revision?: number): DecisionSpec {
    const candidates = [...this.specs.values()].filter((spec) => spec.id === id);
    const result = revision === undefined ? candidates.sort((a, b) => b.revision - a.revision)[0] : this.specs.get(`${id}@${revision}`);
    if (!result) throw new DecisionSpecRegistryError(`DecisionSpec not found: ${id}${revision === undefined ? '' : `@${revision}`}`, 'DECISION_SPEC_NOT_FOUND');
    return result;
  }

  list(): DecisionSpec[] { return [...this.specs.values()].sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision); }
}
