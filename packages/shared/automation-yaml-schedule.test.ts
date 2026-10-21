import { describe, expect, it } from 'vitest';
import { automationYamlDraft, isUnsupportedAutomationYamlInstructionV1, materializeAutomationChangeV1, materializeAutomationYamlV1, suggestAutomationYamlEditV1, validateAutomationYamlV1 } from './automation-yaml';
import type { Automation } from './index';

describe('structured schedule edits', () => {
  it.each(['daily', 'weekdays', 'weekly'] as const)('round trips %s with timezone', type => {
    const cronConfig = { type, hour: 9, minute: 15, ...(type === 'weekly' ? { day: 1 } : {}) };
    const draft = automationYamlDraft({ name: 'schedule', triggerType: 'cron', cronConfig, timezone: 'America/New_York', jobType: 'ai_prompt', prompt: 'briefing', definitionJson: {} } as Automation);
    const updates = materializeAutomationYamlV1(draft).updates;
    expect(updates.cronConfig).toEqual(cronConfig);
    expect(updates.timezone).toBe('America/New_York');
    expect(materializeAutomationYamlV1(draft.replace('hour: 9', 'hour: 8')).updates.cronConfig?.hour).toBe(8);
  });
  it('rejects unsupported natural language rather than claiming to apply it', () => {
    expect(() => materializeAutomationYamlV1('version: 1\ntrigger:\n  type: time\n  schedule: daily at 8')).toThrow();
  });
  it.each(['2h', '0m', '10081m'])('rejects invalid interval %s', every => {
    expect(() => materializeAutomationYamlV1(`version: 1\ntrigger:\n  type: time\n  every: ${every}`)).toThrow();
  });

  const base = { name: 'Check', description: '', triggerType: 'manual', jobType: 'shell', cwd: '.', timeoutSeconds: 60, definitionJson: { command: 'echo old', runner: { preference: 'runtime_box', fallback: 'fail' }, reportPolicy: 'silent' } } as any;
  const draft = () => automationYamlDraft(base);

  it('drafts only supported fields, preserving existing execution policy on a same-kind edit', () => {
    const yaml = draft().replace('echo old', 'echo new');
    expect(yaml).not.toMatch(/^condition:|^ai:|^report:|^  output:/m);
    expect(materializeAutomationChangeV1(yaml, base).updates.definitionJson).toEqual({ ...base.definitionJson, command: 'echo new' });
  });

  it.each([
    ['condition', 'condition:\n  ai_when:\n    - output.ai_needed == true'],
    ['ai', 'ai:\n  prompt: investigate'],
    ['report', 'report:\n  policy: on_error'],
    ['event', 'trigger:\n  type: file_change'],
    ['run.output', '  output: json'],
    ['unknown root', 'mystery: yes'],
  ])('rejects unapplied %s settings in validation and materialization', (_, fragment) => {
    const yaml = fragment.startsWith('trigger:') ? draft().replace(/trigger:\n  type: manual/, fragment)
      : fragment.startsWith('  output:') ? draft().replace('  command: echo old', `  command: echo old\n${fragment}`)
      : `${draft()}\n${fragment}\n`;
    expect(validateAutomationYamlV1(yaml).ok).toBe(false);
    expect(() => materializeAutomationYamlV1(yaml)).toThrow('invalid automation yaml');
  });

  it('rejects duplicate keys and a job-type switch that would lose runner policy', () => {
    expect(validateAutomationYamlV1(`${draft()}\nname: duplicate`).ok).toBe(false);
    const next = draft().replace('type: command', 'type: script').replace('command: echo old', 'path: scripts/check.sh');
    expect(() => materializeAutomationChangeV1(next, base)).toThrow('cannot change the existing job type');
  });

  it('does not turn a requested clock-time change into a new interval', () => {
    const daily = automationYamlDraft({ ...base, triggerType: 'cron', cronConfig: { type: 'daily', hour: 10, minute: 0 }, timezone: 'Asia/Seoul' });
    for (const request of ['10시를 10시 10분으로 바꾸고 싶어', '매일 오전 9시 실행을 오전 10시로 바꾸고 싶어', 'Change 10:00 to 10:10']) {
      const result = suggestAutomationYamlEditV1(daily, request);
      expect(result.changed).toBe(false);
      expect(result.yaml).toBe(daily);
    }
    expect(suggestAutomationYamlEditV1(draft(), '10시를 10시 10분으로 바꿔').changed).toBe(false);
    expect(isUnsupportedAutomationYamlInstructionV1('Change 10:00 to 10:10')).toBe(true);
    expect(isUnsupportedAutomationYamlInstructionV1('매일 오전 9시 실행을 오전 10시로 바꿔')).toBe(true);
  });

  it('only proposes a bounded interval change for an existing interval', () => {
    const scheduled = automationYamlDraft({ ...base, triggerType: 'cron', cronConfig: { type: 'interval', minutes: 30 }, timezone: 'Asia/Seoul' });
    const result = suggestAutomationYamlEditV1(scheduled, '매 15분마다 실행해줘');
    expect(result.changed).toBe(true);
    expect(materializeAutomationChangeV1(result.yaml, base).updates.cronConfig).toEqual({ type: 'interval', minutes: 15 });
    expect(isUnsupportedAutomationYamlInstructionV1('새 결과가 있을 때만 15분마다 AI 호출해줘')).toBe(true);
    for (const request of ['매 0분마다 실행해줘', '매 10081분마다 실행해줘', '새 결과가 있을 때만 15분마다 AI 호출해줘']) {
      const rejected = suggestAutomationYamlEditV1(scheduled, request);
      expect(rejected.changed).toBe(false);
      expect(rejected.yaml).toBe(scheduled);
    }
  });

  it('keeps a saved webhook as a webhook instead of disguising it as an AI prompt', () => {
    const webhook = { ...base, jobType: 'webhook', definitionJson: { url: 'https://example.org/hook' } };
    const yaml = automationYamlDraft(webhook);
    expect(yaml).toContain('type: webhook');
    expect(validateAutomationYamlV1(yaml).ok).toBe(true);
    expect(materializeAutomationYamlV1(yaml).updates.definitionJson).toEqual({ url: 'https://example.org/hook' });
  });
});
