import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './SessionItem.tsx'), 'utf8');

describe('SessionItem run and subagent presentation', () => {
  it('uses the same compact tone pill treatment for runs and subagents', () => {
    expect(source).toMatch(/>\s*run\s*<\/span>/);
    expect(source.match(/tone-pill tone-warning/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('uses one row display model for unread title emphasis and the completion check', () => {
    expect(source).toContain('const activity = deriveSessionRowActivity({');
    expect(source).toContain('const rowState = deriveSessionRowState(activity, isUnreadAttention);');
    expect(source).not.toContain('attentionUsername');
    expect(source).toContain(`rowState.bold ? "font-bold text-gray-100" : "font-medium"`);
    expect(source).toContain(`rowState.indicator.kind === "done"`);
    expect(source).not.toContain("${!turnRead ? 'font-bold text-gray-100' : 'font-medium'}");
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
