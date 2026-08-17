// Owns: immutable behavioral regression cases attached to published Harnesses.
// Public API: validateHarnessEvalPack, summarizeHarnessEvalPack. See README.md.

export type HarnessEvalCategory = 'representative' | 'authority-boundary' | 'ambiguity' | 'tool-failure' | 'prompt-injection';
export type HarnessEvalSeverity = 'score' | 'hard-fail';

export interface HarnessEvalAssertion {
  id: string;
  description: string;
  severity: HarnessEvalSeverity;
  kind: 'required-capability' | 'forbidden-capability' | 'required-behavior' | 'forbidden-behavior';
  value: string;
}

export interface HarnessEvalCase {
  id: string;
  category: HarnessEvalCategory;
  title: string;
  userPrompt: string;
  setup?: {
    availableCapabilities?: string[];
    simulatedFailure?: string;
  };
  assertions: HarnessEvalAssertion[];
}

export interface HarnessEvalPack {
  schemaVersion: 1;
  harnessId: string;
  harnessVersion: number;
  modelRunsPerCase: number;
  cases: HarnessEvalCase[];
}

const REQUIRED_CATEGORIES: readonly HarnessEvalCategory[] = [
  'representative',
  'authority-boundary',
  'ambiguity',
  'tool-failure',
  'prompt-injection',
];

/** Validate an eval pack before it is used as a publish or promotion gate. */
export function validateHarnessEvalPack(pack: HarnessEvalPack): HarnessEvalPack {
  if (pack.schemaVersion !== 1) throw new Error('Unsupported Harness eval pack schemaVersion');
  if (!pack.harnessId.trim() || !Number.isInteger(pack.harnessVersion) || pack.harnessVersion <= 0) throw new Error('Harness eval pack requires a valid Harness version tuple');
  if (!Number.isInteger(pack.modelRunsPerCase) || pack.modelRunsPerCase < 2) throw new Error('Harness eval cases require at least two model runs');
  if (pack.cases.length < 10) throw new Error('Harness eval pack requires at least ten cases');

  const caseIds = new Set<string>();
  const assertionIds = new Set<string>();
  for (const testCase of pack.cases) {
    if (!testCase.id.trim() || caseIds.has(testCase.id)) throw new Error(`Duplicate or empty Harness eval case id: ${testCase.id}`);
    caseIds.add(testCase.id);
    if (!testCase.title.trim() || !testCase.userPrompt.trim()) throw new Error(`Harness eval case ${testCase.id} requires a title and user prompt`);
    if (testCase.assertions.length === 0) throw new Error(`Harness eval case ${testCase.id} requires assertions`);
    for (const assertion of testCase.assertions) {
      const qualifiedId = `${testCase.id}:${assertion.id}`;
      if (!assertion.id.trim() || assertionIds.has(qualifiedId)) throw new Error(`Duplicate or empty Harness eval assertion id: ${qualifiedId}`);
      assertionIds.add(qualifiedId);
      if (!assertion.description.trim() || !assertion.value.trim()) throw new Error(`Harness eval assertion ${qualifiedId} is incomplete`);
    }
  }

  for (const category of REQUIRED_CATEGORIES) {
    if (!pack.cases.some((testCase) => testCase.category === category)) throw new Error(`Harness eval pack is missing category ${category}`);
  }
  if (!pack.cases.some((testCase) => testCase.assertions.some((assertion) => assertion.severity === 'hard-fail'))) {
    throw new Error('Harness eval pack requires at least one hard-fail assertion');
  }
  return pack;
}

/** Return stable coverage metadata for validation reports and Builder UI. */
export function summarizeHarnessEvalPack(pack: HarnessEvalPack): {
  caseCount: number;
  assertionCount: number;
  hardFailAssertionCount: number;
  categoryCounts: Record<HarnessEvalCategory, number>;
} {
  validateHarnessEvalPack(pack);
  const categoryCounts = Object.fromEntries(REQUIRED_CATEGORIES.map((category) => [category, 0])) as Record<HarnessEvalCategory, number>;
  let assertionCount = 0;
  let hardFailAssertionCount = 0;
  for (const testCase of pack.cases) {
    categoryCounts[testCase.category] += 1;
    assertionCount += testCase.assertions.length;
    hardFailAssertionCount += testCase.assertions.filter((assertion) => assertion.severity === 'hard-fail').length;
  }
  return { caseCount: pack.cases.length, assertionCount, hardFailAssertionCount, categoryCounts };
}
