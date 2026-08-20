import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AgentsPanel.tsx'), 'utf8');

describe('AgentsPanel helper terminology', () => {
  it('frames project agent definitions as experts', () => {
    expect(source).toContain("t('agentsPanel.title')");
    expect(source).toContain("t('agentsPanel.description')");
    expect(source).toContain("t('agentsPanel.addExpert')");
    expect(source).toContain("t('agentsPanel.editExpert')");
  });

  it('keeps technical command details secondary to direct delegation', () => {
    expect(source).toContain("t('agentsPanel.taskLabel')");
    expect(source).toContain("t('agentsPanel.delegate')");
    expect(source).not.toContain('프로젝트별 subagent 역할을 보고');
  });
});
