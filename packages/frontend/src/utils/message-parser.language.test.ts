import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import i18n, { i18nReady } from '../i18n';
import { getToolSummary } from './message-parser';

beforeAll(async () => { await i18nReady; });
afterEach(async () => { await i18n.changeLanguage('ko'); });

describe('localized tool summaries', () => {
  it('uses Korean labels when a tool has no descriptive input', async () => {
    await i18n.changeLanguage('ko');
    for (const name of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'AskUserQuestion', 'Task', 'TodoWrite', 'ExitPlanMode', 'credential_vault_input', 'persistent_agent_create', 'persistent_agent_send']) {
      expect(getToolSummary(name, {}), name).toMatch(/[가-힣]/);
    }
  });

  it('localizes work-step counts and preserves explicit English selection', async () => {
    const todos = [{ status: 'completed' }, { status: 'in_progress' }];
    await i18n.changeLanguage('ko');
    expect(getToolSummary('TodoWrite', { todos })).toBe('진행 단계 1/2');
    expect(getToolSummary('TodoWrite', { todos: [{ status: 'pending' }] })).toBe('진행 단계 1개 예정');
    expect(getToolSummary('TodoWrite', { todos: [{ status: 'completed' }] })).toBe('진행 단계 완료 (1/1)');
    await i18n.changeLanguage('en');
    expect(getToolSummary('TodoWrite', { todos })).toBe('Work steps 1/2');
    expect(getToolSummary('Read', {})).toBe('Read file');
  });
});

describe('localized sleep summaries', () => {
  it.each(['sleep', 'Sleep', 'functions.sleep', 'functions__sleep', 'mcp__sleep__sleep', 'mcp__session-wait__sleep', 'mcp__session_wait__sleep'])('normalizes %s without losing the wait details', async (name) => {
    const { getToolLabel, getToolActivityLabel, getToolActivityNoun } = await import('./message-parser');
    await i18n.changeLanguage('ko');
    expect(getToolLabel(name)).toBe('대기');
    expect(getToolActivityLabel(name, {})).toBe('대기 중');
    expect(getToolActivityNoun(name, {})).toBe('대기 중');
    expect(getToolSummary(name, { durationSeconds: 90, reason: '외부 작업' })).toBe('예상 대기 시간 90초 · 외부 작업');
    await i18n.changeLanguage('en');
    expect(getToolLabel(name)).toBe('Wait');
    expect(getToolActivityLabel(name, {})).toBe('Waiting');
    expect(getToolSummary(name, { durationSeconds: 90, reason: '외부 작업' })).toBe('Expected wait: 90 seconds · 외부 작업');
  });

  it.each([undefined, null, '10', -1, NaN, Infinity, {}])('does not invent a duration for %s', async (durationSeconds) => {
    await i18n.changeLanguage('ko');
    expect(getToolSummary('sleep', { durationSeconds })).toBe('대기');
  });

  it('preserves zero, fractional seconds, and input reason text', async () => {
    await i18n.changeLanguage('ko');
    expect(getToolSummary('sleep', { durationSeconds: 0 })).toBe('예상 대기 시간 0초');
    expect(getToolSummary('sleep', { durationSeconds: 0.5, reason: '  준비  ' })).toBe('예상 대기 시간 0.5초 · 준비');
    expect(getToolSummary('sleep', { reason: {} })).toBe('대기');
  });
});
