import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SchedulePanel.tsx', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../../locales/en/schedule.json', import.meta.url), 'utf8'));
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/schedule.json', import.meta.url), 'utf8'));

const visibleKeys = [
  'homeEyebrow',
  'homeTitle',
  'homeDescription',
  'enabledAutomations',
  'filterByProject',
  'requestExamples',
  'reviewChanges',
  'upcomingExecutions',
  'progressStatus',
  'scheduleWizardPrompt',
];

describe('SchedulePanel locale contract', () => {
  it('keeps the default automation screen copy in both locales', () => {
    for (const key of visibleKeys) {
      expect(en[key], `missing English schedule key: ${key}`).toBeTruthy();
      expect(ko[key], `missing Korean schedule key: ${key}`).toBeTruthy();
    }
  });

  it('does not offer unsupported conditional execution as a ready-made example', () => {
    expect(ko.exampleEventOnlyBody).toContain('지원되는지 확인');
    expect(en.exampleEventOnlyBody).toContain('whether this is supported');
    expect(ko.exampleChangeTimeBody).toContain('30분마다');
    expect(en.exampleChangeTimeBody).toContain('30-minute interval');
    expect(ko.exampleChangeTimeBody).not.toContain('10시 10분');
    expect(en.exampleChangeTimeBody).not.toContain('10:10');
  });

  it('routes the automation home and details through schedule locale keys', () => {
    expect(source).toContain("t('homeTitle')");
    expect(source).toContain("t('filterByProject')");
    expect(source).toContain("isCreationDraft(selectedJob) ? 'planDraftResume' : 'reviewChanges'");
    expect(source).toContain("t('progressStatus')");
    expect(source).toContain('<AutomationCreatePanel');
    expect(source).not.toContain("tower-start-schedule-wizard");
    expect(source).not.toContain("defaultValue: '자동화");
    expect(source).not.toContain('>대화로 조정</button>');
  });
});
