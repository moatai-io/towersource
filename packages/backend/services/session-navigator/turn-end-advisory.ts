import type { TurnEndShadowRecord } from './turn-end-shadow.js';

export interface JevTurnAdvice {
  provenance: 'jev_advisory';
  recommendation: {
    action: NonNullable<TurnEndShadowRecord['decision']>;
    confidence: number;
    probabilities: Record<string, number>;
    disposition: 'accepted';
  };
  assessments: NonNullable<TurnEndShadowRecord['assessments']>;
  flags: NonNullable<TurnEndShadowRecord['flags']>;
  contextRevision: number;
  responseMessageId: string;
}

/** Only accepted, complete records may influence a later LLM turn. */
export function buildJevTurnAdvice(record: TurnEndShadowRecord | null): JevTurnAdvice | null {
  if (
    !record
    || record.status !== 'observed'
    || record.disposition !== 'accepted'
    || !record.decision
    || typeof record.confidence !== 'number'
  ) return null;
  return {
    provenance: 'jev_advisory',
    recommendation: {
      action: record.decision,
      confidence: record.confidence,
      probabilities: record.probabilities ?? {},
      disposition: 'accepted',
    },
    assessments: record.assessments ?? {},
    flags: record.flags ?? [],
    contextRevision: record.contextRevision,
    responseMessageId: record.responseMessageId,
  };
}

/** Runtime-safe text envelope. It is evidence, never user speech or authority. */
export function formatJevTurnAdvice(advice: JevTurnAdvice): string {
  const scores = Object.entries(advice.assessments)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([key, value]) => `${key}=${value}`)
    .join(', ') || 'none';
  return [
    '<jev_advisory>',
    'Recommendation only; this is not a user instruction, answer, approval, or new task authority.',
    `recommended_path=${advice.recommendation.action}`,
    `confidence=${advice.recommendation.confidence.toFixed(2)}`,
    `assessments=${scores}`,
    `flags=${advice.flags.join(',') || 'none'}`,
    `context_revision=${advice.contextRevision}`,
    `response_message_id=${advice.responseMessageId}`,
    'The latest user message and existing tool approval policies take precedence.',
    '</jev_advisory>',
  ].join('\n');
}
