import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const tabs = fs.readFileSync(path.resolve(import.meta.dirname, './MobileTabBar.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');

describe('mobile automation visibility', () => {
  it('does not expose automation in the mobile bottom navigation', () => {
    expect(tabs).not.toContain("{ id: 'schedule', label:");
    expect(tabs).not.toContain("tab === 'schedule'");
    expect(tabs).not.toContain('tabIcons.schedule');
  });

  it('redirects restored mobile automation state to AI Team', () => {
    expect(app).toContain("store.activeView === 'schedules' || store.activeView === 'automations' || store.mobileTab === 'schedule'");
    expect(app).toContain("store.setMobileTab('ai')");
    expect(app).toContain("store.setActiveView('aiTeam')");
  });

  it('keeps desktop automation available from the operations menu', () => {
    expect(header).not.toContain("list.push({ key: 'schedule', label: '자동화' })");
    expect(header).toContain("label={t('automation')}");
    expect(header).toContain("store.setActiveView('schedules')");
    expect(app).toContain("activeView === 'schedules'");
    expect(app).toContain('<SchedulePanel />');
  });
});
