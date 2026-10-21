import { parseDecisionSpec } from './decision-spec.js';

/** First routing fixture; not an enabled production policy. */
export const TOWER_REQUEST_ROUTING_SPEC = parseDecisionSpec({
  schemaVersion: 1,
  id: 'tower.request-routing',
  revision: 1,
  purpose: 'Classify a Tower request into a bounded handling route and detect whether fresh external data is required.',
  mode: 'shadow',
  state: {
    maxBytes: 32_768,
    allowedData: ['project', 'session'],
    prohibitedFields: ['credential', 'password', 'secret', 'token'],
  },
  questions: {
    route: {
      type: 'choice',
      instructions: 'Choose the best Tower handling route for this request.',
      criteria: {
        quick_reply: 'Stable knowledge is sufficient and no tool is required.',
        analysis: 'Substantial reasoning is required without changing code or an external system.',
        code_change: 'Source code or Project files must be modified.',
        external_action: 'Fresh external data or an external service action is required.',
        needs_human: 'The supplied state is insufficient for a safe route.',
      },
    },
    needs_fresh_data: {
      type: 'noul',
      instructions: 'Does correctness depend on current or location-specific external information?',
      criteria: { true: 'Fresh external information is required.', false: 'Stable supplied context is sufficient.' },
    },
    complexity: {
      type: 'score',
      instructions: 'How much reasoning and execution complexity does this request require?',
      criteria: ['Trivial', 'Moderate', 'Complex'],
    },
  },
  policy: { minConfidence: 0.8, confidenceQuestionIds: ['route'], onAbstain: 'fallback', fallbackPolicyId: 'tower.agent-existing-route' },
  tags: ['routing', 'jev-pilot'],
});
