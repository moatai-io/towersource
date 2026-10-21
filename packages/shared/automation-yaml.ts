import YAML from 'yaml';
import type { Automation } from './index';

export type AutomationYamlSeverity = 'error' | 'warning' | 'info';

export interface AutomationYamlIssue {
  severity: AutomationYamlSeverity;
  path: string;
  message: string;
}

export interface AutomationYamlValidationResult {
  ok: boolean;
  issues: AutomationYamlIssue[];
}

export interface AutomationConditionEvaluation {
  aiNeeded: boolean;
  matched: string[];
  unmatched: string[];
  errors: string[];
  output: unknown;
}

export interface AutomationYamlEditSuggestion {
  yaml: string;
  summary: string;
  changed: boolean;
}

export interface AutomationYamlMaterializedUpdates {
  name?: string;
  description?: string;
  prompt?: string;
  jobType?: 'ai_prompt' | 'shell' | 'script' | 'webhook' | 'monitor';
  definitionJson?: Record<string, unknown>;
  cwd?: string | null;
  triggerType?: 'manual' | 'cron' | 'once' | 'event';
  cronConfig?: Record<string, unknown> | null;
  onceAt?: string | null;
  timeoutSeconds?: number | null;
  timezone?: string;
}

export interface AutomationYamlMaterializeResult {
  updates: AutomationYamlMaterializedUpdates;
  warnings: string[];
}

export interface AutomationYamlDraftOptions {
  triggerLabel?: (automation: Automation) => string;
}

function readStringRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function automationYamlDraft(a: Automation, opts: AutomationYamlDraftOptions = {}): string {
  const def = readStringRecord(a.definitionJson);
  void opts;
  // Never portray an unknown legacy job/trigger as an executable AI/manual job.
  const trigger = a.triggerType === 'cron' && a.cronConfig
    ? a.cronConfig.type === 'interval'
      ? { type: 'time', every: `${(a.cronConfig as any).minutes ?? ((a.cronConfig as any).hours ?? 1) * 60}m`, timezone: a.timezone }
      : { type: 'time', schedule: a.cronConfig, timezone: a.timezone }
    : a.triggerType === 'once'
      ? { type: 'time', once_at: a.onceAt, timezone: a.timezone }
      : { type: a.triggerType };
  const run = a.jobType === 'shell'
    ? { type: 'command', command: def.command, ...(a.cwd != null ? { cwd: a.cwd } : {}), ...(a.timeoutSeconds != null ? { timeout_seconds: a.timeoutSeconds } : {}) }
    : a.jobType === 'script'
      ? { type: 'script', path: def.path, ...(a.cwd != null ? { cwd: a.cwd } : {}), ...(a.timeoutSeconds != null ? { timeout_seconds: a.timeoutSeconds } : {}) }
      : a.jobType === 'webhook'
        ? { type: 'webhook', url: def.url, ...(a.timeoutSeconds != null ? { timeout_seconds: a.timeoutSeconds } : {}) }
        : a.jobType === 'ai_prompt'
          ? { type: 'ai_prompt', prompt: a.prompt || def.prompt }
          : { type: a.jobType };
  return YAML.stringify({ version: 1, name: a.name, description: a.description, trigger, run });
}

function sectionBody(yaml: string, section: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${section}:`);
  if (start < 0) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z_][\w-]*:\s*$/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

function parseConditionList(yaml: string, key: 'ai_when'): string[] {
  const condition = sectionBody(yaml, 'condition');
  const lines = condition.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*$`).test(line));
  if (start < 0) return [];
  const items: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*[A-Za-z_][\w-]*:\s*$/.test(line)) break;
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (match) items.push(match[1].trim());
  }
  return items;
}

function readOutputPath(output: unknown, pathExpr: string): unknown {
  if (!pathExpr.startsWith('output.')) return undefined;
  const parts = pathExpr.slice('output.'.length).split('.').filter(Boolean);
  let current: any = output;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function parseLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const quote = trimmed.match(/^["'](.*)["']$/);
  if (quote) return quote[1];
  return trimmed;
}

function evaluateExpression(expr: string, output: unknown): { matched: boolean; error?: string } {
  const equality = expr.match(/^(output(?:\.[A-Za-z0-9_-]+)+)\s*==\s*(.+)$/);
  if (equality) return { matched: readOutputPath(output, equality[1]) === parseLiteral(equality[2]) };

  const inList = expr.match(/^(output(?:\.[A-Za-z0-9_-]+)+)\s+in\s+\[(.*)\]$/);
  if (inList) {
    const actual = readOutputPath(output, inList[1]);
    const values = inList[2].split(',').map((part) => parseLiteral(part)).map(String);
    return { matched: values.includes(String(actual)) };
  }

  return { matched: false, error: `지원하지 않는 조건 표현식: ${expr}` };
}

export function evaluateAutomationConditionV1(yaml: string, stdoutText: string | null | undefined): AutomationConditionEvaluation {
  const errors: string[] = [];
  let output: unknown = null;
  if (stdoutText && stdoutText.trim()) {
    try {
      output = JSON.parse(stdoutText);
    } catch (err: any) {
      errors.push(`stdout JSON 파싱 실패: ${err?.message || String(err)}`);
    }
  } else {
    errors.push('stdout JSON이 비어 있습니다.');
  }

  const expressions = parseConditionList(yaml, 'ai_when');
  if (expressions.length === 0) errors.push('condition.ai_when 조건이 없습니다.');

  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const expr of expressions) {
    const result = evaluateExpression(expr, output);
    if (result.error) errors.push(result.error);
    if (result.matched) matched.push(expr);
    else unmatched.push(expr);
  }

  return { aiNeeded: matched.length > 0 && errors.length === 0, matched, unmatched, errors, output };
}

function replaceOrInsertLine(source: string, section: string, key: string, value: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${section}:`);
  if (start < 0) return source;
  const keyPattern = new RegExp(`^(\\s*)${key}:\\s*.*$`);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w-]*:\s*$/.test(lines[i])) break;
    const match = lines[i].match(keyPattern);
    if (match) {
      lines[i] = `${match[1]}${key}: ${value}`;
      return lines.join('\n');
    }
  }
  lines.splice(start + 1, 0, `  ${key}: ${value}`);
  return lines.join('\n');
}

export function isClockTimeAutomationYamlInstructionV1(instruction: string): boolean {
  return /\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*시(?!간)/.test(instruction);
}

export function isUnsupportedAutomationYamlInstructionV1(instruction: string): boolean {
  return isClockTimeAutomationYamlInstructionV1(instruction)
    || /warning|critical|경고|위험|이상|실패|ai_needed|필요할 때|필요할때|있을 때|있을때|새 결과|only when|if .*result|event|이벤트|조건|항상|매번|보고/.test(instruction.toLowerCase());
}

export function suggestAutomationYamlEditV1(yaml: string, instruction: string): AutomationYamlEditSuggestion {
  if (isClockTimeAutomationYamlInstructionV1(instruction)) {
    return { yaml, summary: '시각 변경을 반복 간격으로 해석하지 않습니다. 현재 자동 제안에서는 시각 변경안을 만들 수 없으니 실행 계획에서 별도로 검토해 주세요.', changed: false };
  }
  if (isUnsupportedAutomationYamlInstructionV1(instruction)) {
    return { yaml, summary: '조건부 AI 호출과 보고 정책은 현재 예약 실행에 연결되지 않습니다. 요청의 일부만 적용하지 않으며, 지원되는 시각 변경은 별도로 요청해 주세요.', changed: false };
  }
  // An absolute clock time ("10시 10분") is not an interval ("10분마다").
  // Only offer a fallback edit for an existing interval, never convert a
  // daily/once/manual schedule or leave a conflicting schedule/once_at rule.
  const interval = instruction.match(/(?:매\s*(\d+)\s*(분|시간)|(\d+)\s*(분|시간)\s*마다)/);
  if (!interval || !validateAutomationYamlV1(yaml).ok) {
    return { yaml, summary: '지원되는 자동 변경안을 찾지 못했습니다. 실행 시각과 반복 간격을 구분해 요청해 주세요.', changed: false };
  }
  const trigger = YAML.parse(yaml)?.trigger;
  if (trigger?.type !== 'time' || typeof trigger.every !== 'string' || trigger.schedule !== undefined || trigger.once_at !== undefined) {
    return { yaml, summary: '현재 예약을 반복 간격으로 자동 전환하지 않습니다. 실행 계획에서 시각과 영향을 검토해 주세요.', changed: false };
  }
  const amount = Number(interval[1] ?? interval[3]);
  const unit = interval[2] ?? interval[4];
  const minutes = unit === '시간' ? amount * 60 : amount;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
    return { yaml, summary: '반복 간격은 1분부터 10080분까지 지정할 수 있습니다.', changed: false };
  }
  const next = replaceOrInsertLine(yaml, 'trigger', 'every', `${minutes}m`);
  if (!validateAutomationYamlV1(next).ok) {
    return { yaml, summary: '변경안을 검증할 수 없어 기존 설정을 유지했습니다.', changed: false };
  }
  return { yaml: next, summary: next === yaml ? '이미 요청한 반복 간격으로 설정되어 있습니다.' : `반복 간격을 ${minutes}분으로 바꾸는 변경안입니다. 적용 전에 검토해 주세요.`, changed: next !== yaml };
}

export function materializeAutomationYamlV1(yaml: string): AutomationYamlMaterializeResult {
  const validation = validateAutomationYamlV1(yaml);
  if (!validation.ok) throw new Error(`invalid automation yaml: ${validation.issues.filter(issue => issue.severity === 'error').map(issue => issue.path).join(', ')}`);
  const warnings: string[] = [];
  const doc = YAML.parse(yaml) as any;
  const updates: AutomationYamlMaterializedUpdates = {};
  if (!doc || typeof doc !== 'object') throw new Error('YAML object expected');
  if (doc.version !== 1) throw new Error('version: 1 이 필요합니다.');
  if (typeof doc.name === 'string') updates.name = doc.name;
  if (typeof doc.description === 'string') updates.description = doc.description;

  const trigger = doc.trigger || {};
  if (trigger.timezone !== undefined) {
    if (typeof trigger.timezone !== 'string') throw new Error('Invalid timezone');
    new Intl.DateTimeFormat('en', { timeZone: trigger.timezone });
    updates.timezone = trigger.timezone;
  }
  if (trigger.type === 'manual') {
    updates.triggerType = 'manual'; updates.cronConfig = null; updates.onceAt = null;
  } else if (trigger.type === 'time') {
    if (typeof trigger.once_at === 'string') {
      updates.triggerType = 'once'; updates.onceAt = trigger.once_at; updates.cronConfig = null;
    } else if (typeof trigger.every === 'string') {
      const m = trigger.every.match(/^(\d+)m$/);
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 10080) throw new Error('trigger.every must be 1m..10080m');
      updates.triggerType = 'cron'; updates.cronConfig = { type: 'interval', minutes: m ? Number(m[1]) : 60 }; updates.onceAt = null;
    } else if (trigger.schedule !== undefined) {
      const c = trigger.schedule;
      if (!c || typeof c !== 'object' || !['daily', 'weekdays', 'weekly'].includes(c.type)
        || !Number.isInteger(c.hour) || c.hour < 0 || c.hour > 23
        || !Number.isInteger(c.minute) || c.minute < 0 || c.minute > 59
        || (c.type === 'weekly' && (!Number.isInteger(c.day) || c.day < 0 || c.day > 6))) {
        throw new Error('trigger.schedule requires structured type/hour/minute and weekly day; natural-language edits cannot be applied');
      }
      updates.triggerType = 'cron'; updates.onceAt = null;
      updates.cronConfig = { type: c.type, hour: c.hour, minute: c.minute, ...(c.type === 'weekly' ? { day: c.day } : {}) };
    }
  }

  const run = doc.run || {};
  const def: Record<string, unknown> = {};
  if (run.type === 'command') {
    updates.jobType = 'shell';
    if (typeof run.command === 'string') def.command = run.command;
  } else if (run.type === 'script') {
    updates.jobType = 'script';
    if (typeof run.path === 'string') def.path = run.path;
  } else if (run.type === 'webhook') {
    updates.jobType = 'webhook';
    if (typeof run.url === 'string') def.url = run.url;
  } else if (run.type === 'ai_prompt') {
    updates.jobType = 'ai_prompt';
    if (typeof run.prompt === 'string') updates.prompt = run.prompt;
  }
  if (typeof run.cwd === 'string') updates.cwd = run.cwd;
  if (typeof run.timeout_seconds === 'number') updates.timeoutSeconds = run.timeout_seconds;
  if (Object.keys(def).length > 0) updates.definitionJson = def;
  return { updates, warnings };
}

/** Keep existing runner/transport policy when editing a job of the same kind.
 * Switching kinds needs a separate migration preview; YAML v1 cannot represent
 * the complete legacy execution policy. */
export function materializeAutomationChangeV1(yaml: string, existing: Pick<Automation, 'jobType' | 'definitionJson'>): AutomationYamlMaterializeResult {
  const result = materializeAutomationYamlV1(yaml);
  if (result.updates.jobType !== existing.jobType) throw new Error('YAML v1 cannot change the existing job type; use a dedicated migration preview');
  if (result.updates.definitionJson) {
    result.updates.definitionJson = { ...readStringRecord(existing.definitionJson), ...result.updates.definitionJson };
  }
  return result;
}

export function validateAutomationYamlV1(yaml: string): AutomationYamlValidationResult {
  const issues: AutomationYamlIssue[] = [];
  const add = (path: string, message: string) => issues.push({ severity: 'error' as const, path, message });
  let doc: Record<string, unknown>;
  try {
    const parsed = YAML.parseDocument(yaml, { uniqueKeys: true });
    if (parsed.errors.length) throw parsed.errors[0];
    const value = parsed.toJS();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('YAML object expected');
    doc = value as Record<string, unknown>;
  } catch (err) {
    add('yaml', `YAML 구문 오류: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, issues };
  }
  const record = (value: unknown, path: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      add(path, `${path} 객체가 필요합니다.`);
      return {};
    }
    return value as Record<string, unknown>;
  };
  const only = (value: Record<string, unknown>, allowed: string[], prefix: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add(prefix ? `${prefix}.${key}` : key, '실제 예약 실행에 적용되지 않는 필드입니다. 기존 파일은 보존하고 이 필드를 제거한 변경안만 적용하세요.');
  };
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

  only(doc, ['version', 'name', 'description', 'trigger', 'run'], '');
  if (doc.version !== 1) add('version', 'version: 1 이 필요합니다.');
  if (!text(doc.name)) add('name', '자동화 이름이 필요합니다.');
  if (doc.description !== undefined && typeof doc.description !== 'string') add('description', '설명은 문자열이어야 합니다.');

  const trigger = record(doc.trigger, 'trigger');
  only(trigger, ['type', 'every', 'schedule', 'once_at', 'timezone'], 'trigger');
  if (trigger.timezone !== undefined) {
    try {
      if (!text(trigger.timezone)) throw new Error('invalid');
      new Intl.DateTimeFormat('en', { timeZone: trigger.timezone as string });
    } catch { add('trigger.timezone', '유효한 시간대가 필요합니다.'); }
  }
  if (trigger.type === 'manual') {
    if (Object.keys(trigger).some(k => !['type', 'timezone'].includes(k))) add('trigger', '수동 실행에는 예약 규칙을 지정할 수 없습니다.');
  } else if (trigger.type === 'time') {
    const rules = ['every', 'schedule', 'once_at'].filter(k => trigger[k] !== undefined);
    if (rules.length !== 1) add('trigger', 'time trigger에는 every, schedule, once_at 중 하나만 필요합니다.');
    if (trigger.every !== undefined && (typeof trigger.every !== 'string' || !/^(?:[1-9]\d*)m$/.test(trigger.every) || Number(trigger.every.slice(0, -1)) > 10080)) add('trigger.every', '1m..10080m 간격만 지원합니다.');
    if (trigger.once_at !== undefined && (!text(trigger.once_at) || !Number.isFinite(Date.parse(String(trigger.once_at))))) add('trigger.once_at', '유효한 일회성 시각이 필요합니다.');
    if (trigger.schedule !== undefined) {
      const schedule = record(trigger.schedule, 'trigger.schedule');
      only(schedule, ['type', 'hour', 'minute', 'day'], 'trigger.schedule');
      if (!['daily', 'weekdays', 'weekly'].includes(String(schedule.type)) || !Number.isInteger(schedule.hour) || (schedule.hour as number) < 0 || (schedule.hour as number) > 23 || !Number.isInteger(schedule.minute) || (schedule.minute as number) < 0 || (schedule.minute as number) > 59 || (schedule.type === 'weekly' ? !Number.isInteger(schedule.day) || (schedule.day as number) < 0 || (schedule.day as number) > 6 : schedule.day !== undefined)) add('trigger.schedule', 'daily/weekdays/weekly의 hour, minute 및 weekly day를 확인하세요.');
    }
  } else add('trigger.type', '현재는 time 또는 manual 트리거만 적용할 수 있습니다.');

  const run = record(doc.run, 'run');
  only(run, ['type', 'prompt', 'command', 'path', 'url', 'cwd', 'timeout_seconds'], 'run');
  const byType: Record<string, string> = { ai_prompt: 'prompt', command: 'command', script: 'path', webhook: 'url' };
  const required = byType[String(run.type)];
  if (!required) add('run.type', '지원하는 단일 실행은 ai_prompt, command, script, webhook입니다.');
  else {
    if (!text(run[required])) add(`run.${required}`, '실행에 필요한 값이 없습니다.');
    for (const key of ['prompt', 'command', 'path', 'url']) if (key !== required && run[key] !== undefined) add(`run.${key}`, '다른 실행 종류의 필드입니다.');
  }
  if (run.cwd !== undefined && (typeof run.cwd !== 'string' || !run.cwd.trim() || run.cwd.startsWith('/') && !(/^\/workspace(?:\/|$)/.test(run.cwd)))) add('run.cwd', 'cwd는 상대경로 또는 /workspace 하위여야 합니다.');
  if (run.timeout_seconds !== undefined && (!Number.isInteger(run.timeout_seconds) || (run.timeout_seconds as number) < 1 || (run.timeout_seconds as number) > 900)) add('run.timeout_seconds', 'timeout_seconds는 1..900초여야 합니다.');
  return { ok: issues.length === 0, issues };
}
