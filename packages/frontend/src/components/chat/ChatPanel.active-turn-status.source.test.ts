import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'ChatPanel.tsx'), 'utf8');
const pill = source.slice(source.indexOf('function ActiveTurnStatusPill('), source.indexOf('function phaseLabel('));

describe('composer live turn status restoration', () => {
  it('shows the existing status for every live turn above the input', () => {
    expect(source).toContain('activeTurnStatus={showLiveTurnFooter ? <ActiveTurnStatusPill phase={displayTurnPhase} /> : null}');
    expect(source).not.toContain('data-testid="floating-active-turn-status"');
    expect(source).toContain('<StatusLine isTurnActive={showLiveTurnFooter} />');
    expect(pill).toContain('role="status"');
    expect(pill).toContain('phaseLabel(t, phase, statusLines, turnStartTime)');
  });

  it('does not insert an empty dots row while preserving actual messages and question notices', () => {
    expect(source).not.toContain('AssistantPendingMessageRow');
    expect(source).not.toContain('showInlineAssistantPlaceholder');
    expect(source).not.toContain('showPlaceholderAfterThisMessage');
    expect(source).toContain('<MessageBubble');
    expect(source).toContain('<FloatingQuestionCard');
    expect(source).toContain('{stoppedTurnFooter}');
    expect(source).toContain('const showLiveTurnFooter = isStreaming || showActiveTurnNotice;');
  });

  it('keeps the server-adjusted timer in the pill without requiring token streaming', () => {
    expect(pill).toContain('serverNowMs() - turnStartTime');
    expect(pill).toContain('setInterval(() => setElapsed(nextElapsed()), 1000)');
    expect(pill).toContain('return () => clearInterval(iv)');
    expect(pill).not.toContain('s.isStreaming');
    expect(pill).toContain('if (isAwaitingUser || !turnStartTime)');
    expect(pill).toContain('!isAwaitingUser && elapsed > 0');
    expect(pill).toContain('formatActiveTurnDuration(elapsed)');
    expect(source).toContain('Math.floor(Math.max(0, ms) / 1000)');
  });
});
