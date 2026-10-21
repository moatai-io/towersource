import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const header = fs.readFileSync(path.join(__dirname, 'Header.tsx'), 'utf8');
const publishPanel = fs.readFileSync(path.join(__dirname, '../publish/PublishPanel.tsx'), 'utf8');
const destinationSources = [
  ['automation-panel', '../schedule/SchedulePanel.tsx'],
  ['work-timeline', '../work/ChallengeTimelinePanel.tsx'],
  ['inbox-panel', '../inbox/InboxPanel.tsx'],
  ['favorites-panel', '../favorites/FavoritesPanel.tsx'],
  ['settings-panel', '../settings/SettingsPanel.tsx'],
  ['skills-browser', '../skills/SkillsBrowserV2.tsx'],
] as const;
const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');

describe('global navigation source contracts', () => {
  it('exposes a stable Publishing Hub menu target and destination landmark', () => {
    expect(header).toContain('data-testid={testId}');
    expect(header).toContain('testId="global-nav-publishing"');
    for (const destination of ['automation', 'work', 'inbox', 'settings', 'skills']) {
      expect(header).toContain(`testId="global-nav-${destination}"`);
    }
    expect(header).not.toContain('testId="global-nav-favorites"');
    expect(header).not.toContain('testId="global-nav-personal-credentials"');
    expect(header).toContain('aria-expanded={open}');
    expect(publishPanel).toContain('data-testid="publishing-hub"');
    expect(publishPanel).toContain("aria-label={i18n.t('publish.hubTitle')}");
    for (const [landmark, source] of destinationSources) {
      const contents = fs.readFileSync(path.join(__dirname, source), 'utf8');
      expect(contents).toContain(`data-testid="${landmark}"`);
    }
  });

  it('opens Publishing Hub through the first-class system tab contract', () => {
    expect(app).toContain("onPublishClick={() => useFileStore.getState().openSystemTab('publishing')}");
  });
});
