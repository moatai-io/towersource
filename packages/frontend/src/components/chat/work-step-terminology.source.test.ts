import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const messageSource = readFileSync(new URL('./MessageBubble.tsx', import.meta.url), 'utf8');
const koChat = JSON.parse(readFileSync(new URL('../../locales/ko/chat.json', import.meta.url), 'utf8'));
const parserSource = readFileSync(new URL('../../utils/message-parser.ts', import.meta.url), 'utf8');

describe('Work Steps terminology', () => {
  it('labels TodoWrite UI as 진행 단계', () => {
    expect(koChat.toolLabels.todowrite).toBe('진행 단계');
    expect(koChat.toolActivity.todo).toContain('진행 단계');
    expect(koChat.toolActivityNoun.todo).toBe('진행 단계');
    expect(messageSource).toContain("i18n.t('chat:workSteps')");
    expect(messageSource).toContain("i18n.t('chat:previousWorkSteps')");
  });

  it('uses Work steps rather than personal todo language in fallbacks', () => {
    expect(parserSource).toContain("todowrite: 'Work steps'");
    expect(parserSource).toContain("return 'Work steps'");
  });
});
