import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const hub = fs.readFileSync(path.resolve(import.meta.dirname, './WorkHub.tsx'), 'utf8');
const inbox = fs.readFileSync(path.resolve(import.meta.dirname, '../inbox/InboxPanel.tsx'), 'utf8');
const timeline = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('mobile Work hub composition', () => {
  it('shows one selected work list below desktop width and a two-column control board on desktop', () => {
    expect(hub).toContain("useState<'attention' | 'progress'>");
    expect(hub).toContain("t('workHub.attentionTab')");
    expect(hub).toContain("t('workHub.progressTab')");
    expect(hub).toContain("mobileSection === 'attention' ? 'block' : 'hidden'");
    expect(hub).toContain("mobileSection === 'progress' ? 'block' : 'hidden'");
    expect(hub).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]');
    expect(hub).toContain('lg:block lg:min-h-0');
    expect(hub).toContain('lg:overflow-y-auto lg:border-l');
  });

  it('opens attention first when unread results exist without overriding a user tab choice', () => {
    expect(hub).toContain("unreadResultCount > 0 ? 'attention' : 'progress'");
    expect(hub).toContain('mobileSectionChosen.current');
    expect(hub).toContain("if (!mobileSectionChosen.current && unreadResultCount > 0) setMobileSection('attention')");
  });

  it('keeps result rows compact and hides secondary ownership metadata on narrow screens', () => {
    expect(inbox).toContain('min-h-16');
    expect(inbox).toContain('hidden shrink-0 text-[11px] text-surface-600 sm:inline');
    expect(inbox).toContain('line-clamp-2');
  });

  it('supports an embedded progress mode without repeating the full page title', () => {
    expect(timeline).toContain("embedded = false");
    expect(timeline).toContain('{!embedded && (');
    expect(timeline).toContain('{embedded && <div');
    expect(timeline).toContain('<WorkstreamList embedded={embedded}');
  });
});
