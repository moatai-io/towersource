import { describe, expect, it } from 'vitest';
import type { Automation } from '@tower/shared';
import { automationYamlDraft, evaluateAutomationConditionV1, validateAutomationYamlV1 } from './automation-yaml';

const baseAutomation: Automation = {
  id: 'a1',
  userId: 1,
  projectId: 'p1',
  name: '자체 호스팅 서버 감시',
  description: 'VM 상태를 확인한다.',
  prompt: '상태를 요약해줘.',
  model: 'litellm-responses/mini',
  workflow: 'auto',
  jobType: 'shell',
  scopeType: 'project',
  definitionJson: { command: 'python automations/scripts/check.py', cwd: '.', runner: { preference: 'runtime_box', fallback: 'fail' } },
  riskLevel: 'low',
  timeoutSeconds: 120,
  timezone: 'Asia/Seoul',
  createdBySessionId: null,
  updatedByUserId: null,
  mode: 'channel',
  targetId: null,
  cwd: '.',
  triggerType: 'cron',
  cronConfig: { type: 'interval', minutes: 30 },
  onceAt: null,
  status: 'idle',
  enabled: true,
  sortOrder: 0,
  sessionId: null,
  nextRunAt: null,
  lastRunAt: null,
  runCount: 0,
  lastStatus: null,
  lastError: null,
  progressSummary: [],
  todoSnapshot: null,
  parentId: null,
  worktreePath: null,
  roomId: null,
  triggeredBy: null,
  roomMessageId: null,
  creatorName: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  completedAt: null,
};

describe('automationYamlDraft', () => {
  it('creates a valid v1 YAML draft from an existing automation', () => {
    const yaml = automationYamlDraft(baseAutomation);
    expect(yaml).toContain('version: 1');
    expect(yaml).toContain('every: 30m');
    expect(yaml).toContain('command: python automations/scripts/check.py');
    expect(validateAutomationYamlV1(yaml).ok).toBe(true);
  });
});

describe('evaluateAutomationConditionV1', () => {
  it('matches simple ai_when output conditions', () => {
    const yaml = automationYamlDraft(baseAutomation);
    const result = evaluateAutomationConditionV1(yaml, JSON.stringify({ ai_needed: true, status: 'ok' }));
    expect(result.aiNeeded).toBe(true);
    expect(result.matched).toContain('output.ai_needed == true');
  });

  it('supports string membership checks', () => {
    const yaml = `version: 1
name: Status
trigger:
  type: manual
run:
  type: command
  command: echo hi
condition:
  ai_when:
    - output.status in ["warning", "critical"]
ai:
  prompt: hi
report:
  policy: auto
`;
    expect(evaluateAutomationConditionV1(yaml, JSON.stringify({ status: 'critical' })).aiNeeded).toBe(true);
    expect(evaluateAutomationConditionV1(yaml, JSON.stringify({ status: 'ok' })).aiNeeded).toBe(false);
  });
});

describe('validateAutomationYamlV1', () => {
  it('rejects missing required sections', () => {
    const result = validateAutomationYamlV1('version: 1\nname: Broken\n');
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('trigger');
    expect(result.issues.map((issue) => issue.path)).toContain('run');
  });

  it('rejects unsafe absolute cwd for project automation', () => {
    const result = validateAutomationYamlV1(`version: 1
name: Unsafe
trigger:
  type: manual
run:
  type: command
  cwd: /tmp
  command: echo hi
condition:
  ai_when:
    - output.ai_needed == true
ai:
  prompt: hi
report:
  policy: auto
`);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ path: 'run.cwd' }));
  });
});
