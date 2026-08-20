import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'RunCanvasPanel.tsx'), 'utf8');

describe('RunCanvasPanel locale contract', () => {
  it('routes visible Process Map and Automation Scout copy through chat locale keys', () => {
    for (const key of [
      'runCanvas.loading',
      'runCanvas.emptyTitle',
      'runCanvas.expand',
      'runCanvas.waitingForRun',
      'runCanvas.analyzeAutomation',
      'runCanvas.confirmAutomationTitle',
      'runCanvas.scoutStartedTitle',
    ]) {
      expect(source).toContain(key);
    }
  });

  it('preserves the canonical Korean Automation Scout prompt as operational behavior', () => {
    expect(source).toContain('이 Process Map 흐름을 자동화/스킬화 후보로 분석해줘.');
    expect(source).toContain('새 사이드바 세션을 spawn하지 말고');
  });
});
