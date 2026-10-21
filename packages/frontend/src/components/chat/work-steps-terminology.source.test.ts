import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bubble = readFileSync(new URL('./MessageBubble.tsx', import.meta.url), 'utf8');
const card = readFileSync(new URL('./ToolUseCard.tsx', import.meta.url), 'utf8');
const ko = readFileSync(new URL('../../locales/ko/chat.json', import.meta.url), 'utf8');
const parser = readFileSync(new URL('../../utils/message-parser.ts', import.meta.url), 'utf8');

describe('TodoWrite user-facing terminology', () => {
  it('uses 작업 기록 for both live and folded cards', () => {
    expect(bubble).toContain("i18n.t('chat:workSteps')");
    expect(bubble).not.toContain('chat:workStepsRecord');
    expect(bubble).toContain("i18n.t('chat:workStepsExpand')");
    expect(ko).toContain('"workSteps": "작업 기록"');
    expect(ko).not.toContain('"workStepsRecord"');
    expect(ko).toContain('"workStepsLastRecorded": "마지막 기록"');
    expect(card).toContain("i18n.t('chat:workSteps')");
    expect(ko).toContain('"todowrite": "작업 기록"');
    expect(ko).toContain('"todo": "작업 기록을 정리하고 있습니다"');
  });

  it('uses Work steps instead of personal todo language in fallback labels', () => {
    expect(parser).toContain("todowrite: 'Work steps'");
    expect(parser).toContain("if (!todos?.length) return getToolLabel(name)");
    expect(parser).not.toContain("todowrite: 'Manage todos'");
  });
});
