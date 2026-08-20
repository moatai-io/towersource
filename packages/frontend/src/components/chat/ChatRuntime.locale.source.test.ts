import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const panel = fs.readFileSync(path.resolve(__dirname, 'ChatPanel.tsx'), 'utf8');
const runtime = fs.readFileSync(path.resolve(__dirname, '../../hooks/useChatRuntime.ts'), 'utf8');

describe('chat runtime locale contract', () => {
  it('routes history loading, jump, resume, and stopped-turn chrome through chat locale keys', () => {
    for (const key of [
      'jumpToLatest',
      'loadingOlderMessages',
      'scrollForOlderMessages',
      'autoResume.title',
      'autoResume.label',
      'stoppedTurn.title',
      'stoppedTurn.savedHint',
    ]) expect(panel).toContain(key);
  });

  it('formats auto-resume time with the active language while preserving legacy project-home data', () => {
    expect(panel).toContain('i18n.resolvedLanguage || i18n.language');
    expect(panel).toContain("title: `${activeProject.agent?.displayName || activeProject.name} 홈`");
  });

  it('routes runtime feedback and generated compact markers through the i18n singleton', () => {
    for (const key of [
      'chat:runtime.steeringCanceled',
      'chat:runtime.alreadyFinished',
      'chat:runtime.compactComplete',
      'chat:runtime.compactFailed',
      'chat:runtime.questionTimedOut',
      'chat:runtime.websocketNotReady',
    ]) expect(runtime).toContain(key);
    expect(runtime).toContain("new CustomEvent('restore-input-text'");
    expect(runtime).toContain("case 'ask_user_timeout'");
  });
});
