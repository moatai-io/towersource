import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'AgentHiringWizard.tsx'), 'utf8');

describe('AgentHiringWizard locale contract', () => {
  it('routes the Academy chrome, modes, actions, and errors through locale keys', () => {
    for (const key of [
      'agentAcademy.error.draftFallback',
      'agentAcademy.title',
      'agentAcademy.mode.chatTitle',
      'agentAcademy.materialPlaceholder',
      'agentAcademy.suggestDraft',
      'agentAcademy.firstSuccess',
      'agentAcademy.workExamples',
      'agentAcademy.workScope',
      'agentAcademy.startChat',
    ]) expect(source).toContain(key);
  });

  it('treats cards as optional work examples instead of fixed roles', () => {
    expect(source).toContain('/(회사소개|소개서|브로슈어|브랜드|소개)/i');
    expect(source).toContain('const WORK_EXAMPLES: WorkExample[]');
    expect(source).toContain('These are optional starting examples');
    expect(source).toContain('시작 운영 원칙:');
    expect(source).not.toContain('현재 등급:');
    expect(source).not.toContain('다음 승진 조건:');
    expect(source).not.toContain('templateId: template.id');
  });
});
