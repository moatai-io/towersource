import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './SessionItem.tsx'), 'utf8');
const railSource = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/AgentNavigationRail.tsx'), 'utf8');
const fadeSource = fs.readFileSync(path.resolve(import.meta.dirname, '../common/FadeOverflowText.tsx'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.css'), 'utf8');

describe('SessionItem run and subagent presentation', () => {
  it('uses the same compact tone pill treatment for runs and subagents', () => {
    expect(source).toMatch(/>\s*run\s*<\/span>/);
    expect(source).toContain('<AgentSessionBadge session={session} />');
    expect(source).toContain('features/agent-sessions/AgentSessionBadge');
  });

  it('uses one row display model for unread title emphasis and the completion check', () => {
    expect(source).toContain('const activity = deriveSessionRowActivity({');
    expect(source).toContain('const rowState = deriveSessionRowState(activity, isUnreadAttention);');
    expect(source).not.toContain('attentionUsername');
    expect(source).toContain(`rowState.bold ? "font-bold text-gray-100" : "font-medium"`);
    expect(source).toContain(`rowState.indicator.kind === "done"`);
    expect(source).not.toContain("${!turnRead ? 'font-bold text-gray-100' : 'font-medium'}");
  });

  it('fades session and agent names only when the rendered text actually overflows', () => {
    expect(source).toContain('<FadeOverflowText');
    expect(railSource).toContain('<FadeOverflowText');
    expect(fadeSource).toContain('element.scrollWidth > element.clientWidth + 1');
    expect(fadeSource).toContain('new ResizeObserver(measure)');
    expect(fadeSource).toContain("data-overflowing={overflowing ? 'true' : 'false'}");
    expect(cssSource).toContain(".fade-overflow-text[data-overflowing='true']");
    expect(cssSource).toContain('mask-image: linear-gradient(to right');
    expect(cssSource).toContain('text-overflow: clip');
  });

  it('does not use the decorative robot marker for subagent sessions', () => {
    expect(source).not.toContain('🤖 agent');
    expect(source).not.toContain('Subagent session');
  });

  it('marks long-context sessions with a compact LONG badge', () => {
    expect(source).toContain('function isLongContextSessionModel');
    expect(source).toContain('const longContext = isLongContextSessionModel(session.modelUsed);');
    expect(source).toContain("title={t('longContextRouteHint')}");
    expect(source).toContain('>\n                LONG\n              </span>');
  });
});
