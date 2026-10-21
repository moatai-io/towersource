import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const hub = fs.readFileSync(path.resolve(import.meta.dirname, './WorkHub.tsx'), 'utf8');
const inbox = fs.readFileSync(path.resolve(import.meta.dirname, '../inbox/InboxPanel.tsx'), 'utf8');

describe('desktop Work control board', () => {
  it('keeps ongoing work primary and attention in a bounded right rail', () => {
    expect(hub).toContain('<main');
    expect(hub).toContain('<ChallengeTimelinePanel embedded />');
    expect(hub).toContain('<aside');
    expect(hub).toContain('<InboxPanel variant="work-results"');
    expect(hub).toContain('@min-[64rem]/work:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]');
    expect(hub).toContain('@min-[64rem]/work:border-l');
  });

  it('adapts result-list chrome for the right rail instead of nesting another dashboard card', () => {
    expect(inbox).toContain('lg:max-w-none');
    expect(inbox).toContain('lg:border-0 lg:bg-transparent lg:px-0');
  });
});
