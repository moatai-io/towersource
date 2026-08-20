import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bubble = readFileSync(new URL('./MessageBubble.tsx', import.meta.url), 'utf8');
const card = readFileSync(new URL('./ToolUseCard.tsx', import.meta.url), 'utf8');
const ko = readFileSync(new URL('../../locales/ko/chat.json', import.meta.url), 'utf8');
const parser = readFileSync(new URL('../../utils/message-parser.ts', import.meta.url), 'utf8');

describe('TodoWrite user-facing terminology', () => {
  it('calls TodoWrite progress 진행 단계 in Korean UI', () => {
    expect(bubble).toContain("i18n.t('chat:workSteps')");
    expect(bubble).toContain("i18n.t('chat:previousWorkSteps')");
    expect(card).toContain("i18n.t('chat:workSteps')");
    expect(ko).toContain('"todowrite": "진행 단계"');
    expect(ko).toContain('"todo": "진행 단계를 정리하고 있습니다"');
  });

  it('uses Work steps instead of personal todo language in fallback labels', () => {
    expect(parser).toContain("todowrite: 'Work steps'");
    expect(parser).toContain("return 'Work steps'");
    expect(parser).not.toContain("todowrite: 'Manage todos'");
  });
});
