import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const automationPanel = readFileSync(new URL('./AutomationPanel.tsx', import.meta.url), 'utf8');
const scheduleTabView = readFileSync(new URL('../schedule/ScheduleTabView.tsx', import.meta.url), 'utf8');
const workbench = readFileSync(new URL('../../features/automation-workbench/AutomationWorkbenchModal.tsx', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../../locales/en/automation.json', import.meta.url), 'utf8'));
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/automation.json', import.meta.url), 'utf8'));

const requiredKeys = [
  'triggerDaily',
  'triggerWeekly',
  'automationRunning',
  'workbenchEditRequired',
  'previewFlowTitle',
  'createReviewDraft',
  'applyConfirm',
  'automationConversation',
  'conversationCardDescription',
  'session',
  'channel',
  'workbenchTitle',
  'server',
];

describe('automation locale contract', () => {
  it('keeps required Workbench keys in both languages', () => {
    for (const key of requiredKeys) {
      expect(en[key], `missing English automation key: ${key}`).toBeTruthy();
      expect(ko[key], `missing Korean automation key: ${key}`).toBeTruthy();
    }
  });

  it('routes visible automation labels through locale keys', () => {
    expect(automationPanel).toContain("t('automationRunning')");
    expect(automationPanel).toContain("t('workbenchEditRequired')");
    expect(scheduleTabView).toContain("useTranslation('schedule')");
    expect(workbench).toContain("useTranslation('automation')");
    expect(workbench).toContain("t('previewFlowTitle')");
    expect(workbench).toContain("t('automationConversation')");
    expect(scheduleTabView).toContain("t('schedule')");
    expect(automationPanel).toContain("t('prompt')");
    expect(automationPanel).toContain("t('lastRun')");
    expect(workbench).toContain("t('workbenchTitle')");
  });
});
