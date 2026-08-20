import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sessionItem = fs.readFileSync(path.resolve(import.meta.dirname, './SessionItem.tsx'), 'utf8');
const runtime = fs.readFileSync(path.resolve(import.meta.dirname, '../../hooks/useChatRuntime.ts'), 'utf8');
const chatStore = fs.readFileSync(path.resolve(import.meta.dirname, '../../stores/chat-store.ts'), 'utf8');

describe('session turn elapsed time UI contract', () => {
  it('restores acceptedAt rather than restarting active timers at zero', () => {
    expect(runtime).toContain("Date.parse(data.turnTiming?.acceptedAt || '')");
    expect(runtime).toContain('streamingSessionRuns');
    expect(chatStore).toContain('startedAt: meta.startedAt ??');
  });

  it('shows the latest tool activity with elapsed time for running sessions', () => {
    expect(sessionItem).toContain(`rowState.indicator.summary || t("writingResponse")`);
    expect(sessionItem).toContain('{runningActivity}');
    expect(sessionItem).toContain('· {runningElapsed}');
    expect(sessionItem).not.toContain('작업 중 · {runningElapsed}');
    expect(sessionItem).toContain(`rowState.elapsed !== "none" && turnState?.startedAt`);
    expect(sessionItem).toContain("{t('answerNeeded')}{turnElapsed ? ` · ${turnElapsed}` : \"\"}");
    expect(sessionItem).toContain('!runningElapsed && conversationTurnCount > 0');
    expect(sessionItem).toContain("title={t('recentActivity')}");
  });
});
