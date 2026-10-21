import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ChatPanel.tsx', import.meta.url), 'utf8');

describe('ChatPanel compaction status', () => {
  it('shows the active compact lifecycle even before the run-state snapshot catches up', () => {
    expect(source).toMatch(/const displayTurnPhase: TurnPhase = compactingSessionId === activeSessionId && activeSessionId !== null\s*\? 'compacting'\s*: activeTurn\.phase/);
    expect(source).toMatch(/<ActiveTurnStatusPill phase=\{displayTurnPhase\}/);
  });
});
