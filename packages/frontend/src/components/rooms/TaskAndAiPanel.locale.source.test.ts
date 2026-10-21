import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const panel = fs.readFileSync(path.resolve(__dirname, 'AiPanel.tsx'), 'utf8');

describe('task and AI panel locale contract', () => {

  it('localizes AI panel empty, anchor, and question-input chrome', () => {
    for (const key of [
      'thread.noConversationYet',
      'thread.currentFilePrefix',
      'thread.answerQuestionPlaceholder',
    ]) expect(panel).toContain(key);
  });

  it('preserves CAD and automation anchor detection and pending-question behavior', () => {
    expect(panel).toContain('isCadFileAnchor');
    expect(panel).toContain('isAutomationAnchor');
    expect(panel).toContain('<FloatingQuestionCard');
  });
});
