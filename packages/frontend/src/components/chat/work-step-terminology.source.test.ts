import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const messageSource = readFileSync(new URL('./MessageBubble.tsx', import.meta.url), 'utf8');
const koChat = JSON.parse(readFileSync(new URL('../../locales/ko/chat.json', import.meta.url), 'utf8'));
const parserSource = readFileSync(new URL('../../utils/message-parser.ts', import.meta.url), 'utf8');

describe('Work Steps terminology', () => {
  it('labels TodoWrite UI as 작업 기록', () => {
    expect(koChat.toolLabels.todowrite).toBe('작업 기록');
    expect(koChat.toolActivity.todo).toContain('작업 기록');
    expect(koChat.toolActivityNoun.todo).toBe('작업 기록');
    expect(messageSource).toContain("i18n.t('chat:workSteps')");
    // Live and historical snapshots share the same Work log heading, with a
    // collapsed disclosure and explicit last-recorded status.
    expect(messageSource).toContain("i18n.t('chat:workStepsExpand')");
    expect(messageSource).toContain("i18n.t('chat:workStepsLastRecorded')");
    expect(koChat.workStepsLastRecorded).toBe('마지막 기록');
  });

  it('uses Work steps rather than personal todo language in fallbacks', () => {
    expect(parserSource).toContain("todowrite: 'Work steps'");
    expect(parserSource).toContain("if (!todos?.length) return getToolLabel(name)");
  });
});
