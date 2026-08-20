import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const task = fs.readFileSync(path.resolve(__dirname, '../kanban/NewTaskModal.tsx'), 'utf8');
const panel = fs.readFileSync(path.resolve(__dirname, 'AiPanel.tsx'), 'utf8');

describe('task and AI panel locale contract', () => {
  it('localizes reporting display copy while preserving stored policy and engine IDs', () => {
    expect(task).toContain("const ENGINE_OPTION_IDS = ['claude', 'pi'] as const");
    expect(task).toContain("const REPORT_POLICY_OPTION_IDS = ['silent', 'notification'] as const");
    expect(task).toContain("t('reportPolicy.label')");
    expect(task).toContain("t('reportPolicy.silentHint')");
    expect(task).toContain('reportPolicy,');
  });

  it('localizes AI panel empty, anchor, CAD selection, and question-input chrome', () => {
    for (const key of [
      'thread.noConversationYet',
      'thread.currentFilePrefix',
      'thread.currentCadSelection',
      'thread.selectionArea',
      'thread.answerQuestionPlaceholder',
    ]) expect(panel).toContain(key);
  });

  it('preserves CAD and automation anchor detection and pending-question behavior', () => {
    expect(panel).toContain('isCadFileAnchor');
    expect(panel).toContain('isAutomationAnchor');
    expect(panel).toContain('currentCadSelection');
    expect(panel).toContain('<FloatingQuestionCard');
  });
});
