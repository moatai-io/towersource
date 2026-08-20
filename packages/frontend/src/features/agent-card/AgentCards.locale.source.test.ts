import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'AgentCards.tsx'), 'utf8');

describe('AgentCards locale contract', () => {
  it('routes status, expansion, artifacts, provenance, and session actions through chat locale keys', () => {
    for (const key of [
      'agentCard.yesterdayAt',
      'agentCard.working',
      'agentCard.expandResponse',
      'agentCard.relatedFiles',
      'agentCard.suggestedNext',
      'agentCard.openParentSession',
      'agentCard.expandRequest',
    ]) expect(source).toContain(key);
  });

  it('keeps legacy Korean agent-message prefix cleanup for stored messages', () => {
    expect(source).toContain('${escapedName} 답');
    expect(source).toContain('${escapedName} 에서');
  });
});
