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
      'agentAcademy.nextPromotion',
      'agentAcademy.startChat',
    ]) expect(source).toContain(key);
  });

  it('preserves Korean intent matching and canonical generated instruction data', () => {
    expect(source).toContain('/(회사소개|소개서|브로슈어|브랜드|소개)/i');
    expect(source).toContain('핵심 운영 원칙:');
    expect(source).toContain('현재 등급:');
  });
});
