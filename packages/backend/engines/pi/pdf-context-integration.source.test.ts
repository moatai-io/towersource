import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const engine = fs.readFileSync(new URL('../pi-engine.ts', import.meta.url), 'utf8');
describe('PDF observation and live context measurement integration', () => {
  it('hydrates only branch receipts, persists terminal notes, and shares hook/transform state', () => {
    expect(engine).toMatch(/sessionMgr\.getBranch\(\)[\s\S]*PDF_OBSERVATION_ENTRY/);
    expect(engine).toContain('sessionMgr.appendCustomEntry(PDF_OBSERVATION_ENTRY, value)');
    expect(engine).toMatch(/await piBeforeToolCall\(context, signal\)[\s\S]*if \(policy\?\.block\) return policy;[\s\S]*pdfObservationState.beforeToolCall\(context\)/);
    expect(engine).toContain('installPiVisualContextTransform(session.agent, pdfObservationState)');
    expect(engine).toMatch(/event.type === 'message_end'[\s\S]*pdfObservationState.observe/);
  });
  it('holds unrecorded final prose and finishes the terminal batch through native hooks', () => {
    expect(engine).toContain('entry.pdfObservationState?.hasPending(entry.session.agent.state.messages)');
    expect(engine).toContain('entry.pdfObservationState?.suppressVisibleFinal(msg, entry.session.agent.state.messages)');
    expect(engine).toContain('session.agent.finishTurn = async');
    expect(engine).toContain('session.agent.prepareNextTurn = async');
    expect(engine).toContain('entry.pdfObservationState?.completionIncomplete');
    expect(engine).toContain('pdfObservationState,');
  });
  it('emits context measurements separately from turn summaries and reopens compact notifications', () => {
    expect(engine).toMatch(/type: 'context_usage', sessionId, msgId, measuredAt: Date.now\(\)/);
    expect(engine).toContain('contextInputTokens: runCtx.actualContextInputTokens()');
    expect(engine).not.toContain('compactionNoticeEmittedThisTurn');
    expect(engine).toContain('if (visibleCompactionInProgress) return');
    expect(engine).toContain('if (!visibleCompactionInProgress)');
  });
});
