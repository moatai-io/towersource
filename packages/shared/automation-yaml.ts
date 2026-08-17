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

function slugifyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9가-힣]+/gi, '-').replace(/^-|-$/g, '') || 'automation';
}

export function automationYamlDraft(a: Automation, opts: AutomationYamlDraftOptions = {}): string {
  const def = readStringRecord(a.definitionJson);
  const label = opts.triggerLabel?.(a) || '';
  const trigger = a.triggerType === 'cron' && a.cronConfig
    ? a.cronConfig.type === 'interval'
      ? `  type: time\n  every: ${((a.cronConfig as any).minutes ?? ((a.cronConfig as any).hours ?? 1) * 60)}m`
      : `  type: time\n  schedule: ${label || 'TBD'}`
    : a.triggerType === 'once'
      ? `  type: time\n  once_at: ${a.onceAt || 'TBD'}`
      : `  type: manual\n  label: 지금 실행`;
  const command = typeof def.command === 'string' ? def.command : '';
  const scriptPath = typeof def.path === 'string' ? def.path : '';
  const runType = a.jobType === 'shell' || command ? 'command' : a.jobType === 'script' || scriptPath ? 'script' : 'ai_prompt';
  const runBlock = runType === 'ai_prompt'
    ? `run:\n  type: ai_prompt\n  prompt: |\n${(a.prompt || String(def.prompt || 'TBD')).split('\n').map((line: string) => `    ${line}`).join('\n')}`
    : `run:\n  type: ${runType}\n  cwd: ${String(def.cwd || a.cwd || '.')}\n  ${runType === 'script' ? `path: ${scriptPath || 'automations/scripts/example.sh'}` : `command: ${command || 'echo TBD'}`}\n  output: json\n  timeout_seconds: ${a.timeoutSeconds ?? 60}`;

  return `version: 1\nname: ${a.name}\ndescription: ${a.description || 'TBD'}\n\ntrigger:\n${trigger}\n\n${runBlock}\n\ncondition:\n  ai_when:\n    - output.ai_needed == true\n\nai:\n  prompt_file: automations/prompts/${slugifyName(a.name)}.md\n  include:\n    - run.stdout_json\n    - run.stderr\n    - previous_run.summary\n\nreport:\n  policy: auto\n  target: project_townhall\n`;
}

function hasLine(yaml: string, pattern: RegExp): boolean {
  return yaml.split('\n').some((line) => pattern.test(line));
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

function replaceAiWhen(source: string, expression: string): string {
  return source.replace(/condition:\n(?:  .*\n)*/m, `condition:\n  ai_when:\n    - ${expression}\n`);
}

export function suggestAutomationYamlEditV1(yaml: string, instruction: string): AutomationYamlEditSuggestion {
  let next = yaml;
  const changes: string[] = [];
  const text = instruction.toLowerCase();
  const minutes = instruction.match(/(\d+)\s*분/);
  if (minutes) {
    next = replaceOrInsertLine(next, 'trigger', 'type', 'time');
    next = replaceOrInsertLine(next, 'trigger', 'every', `${minutes[1]}m`);
    changes.push(`${minutes[1]}분마다 확인하도록 바꿨습니다.`);
  }
  const hours = instruction.match(/(\d+)\s*시간/);
  if (!minutes && hours) {
    next = replaceOrInsertLine(next, 'trigger', 'type', 'time');
    next = replaceOrInsertLine(next, 'trigger', 'every', `${Number(hours[1]) * 60}m`);
    changes.push(`${hours[1]}시간마다 확인하도록 바꿨습니다.`);
  }
  if (/warning|critical|경고|위험|이상|실패/.test(text)) {
    next = replaceAiWhen(next, 'output.status in ["warning", "critical", "failed"]');
    changes.push('경고/위험/실패 상태일 때 AI가 나서도록 바꿨습니다.');
  }
  if (/ai_needed|필요할 때|필요할때|이상할 때|이상할때/.test(text)) {
    next = replaceAiWhen(next, 'output.ai_needed == true');
    changes.push('점검 결과가 AI 필요 신호를 줄 때만 AI가 나서도록 바꿨습니다.');
  }
  if (/항상|매번|항상.*요약/.test(text)) {
    next = replaceAiWhen(next, 'output.always == true');
    changes.push('항상 AI가 나서도록 조건을 명시했습니다. 점검 스크립트가 output.always를 내보내야 합니다.');
  }
  return { yaml: next, summary: changes[0] ? changes.join(' ') : '아직 자동으로 바꿀 수 있는 요청을 찾지 못했습니다. 문장으로 더 구체적으로 말해 주세요.', changed: next !== yaml };
}

export function materializeAutomationYamlV1(yaml: string): AutomationYamlMaterializeResult {
  const warnings: string[] = [];
  const doc = YAML.parse(yaml) as any;
  const updates: AutomationYamlMaterializedUpdates = {};
  if (!doc || typeof doc !== 'object') throw new Error('YAML object expected');
  if (doc.version !== 1) throw new Error('version: 1 이 필요합니다.');
  if (typeof doc.name === 'string') updates.name = doc.name;
  if (typeof doc.description === 'string') updates.description = doc.description;

  const trigger = doc.trigger || {};
  if (trigger.type === 'manual') {
    updates.triggerType = 'manual'; updates.cronConfig = null; updates.onceAt = null;
  } else if (trigger.type === 'time') {
    if (typeof trigger.once_at === 'string') {
      updates.triggerType = 'once'; updates.onceAt = trigger.once_at; updates.cronConfig = null;
    } else if (typeof trigger.every === 'string') {
      const m = trigger.every.match(/^(\d+)m$/);
      if (!m) warnings.push('trigger.every는 현재 10m 같은 분 단위만 registry에 반영합니다.');
      updates.triggerType = 'cron'; updates.cronConfig = { type: 'interval', minutes: m ? Number(m[1]) : 60 }; updates.onceAt = null;
    } else if (typeof trigger.schedule === 'string') {
      warnings.push('자연어 schedule은 아직 registry에 정확히 반영하지 않습니다. 기존 schedule을 유지할 수 있습니다.');
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

export function validateAutomationYamlV1(yaml: string): AutomationYamlValidationResult {
  const issues: AutomationYamlIssue[] = [];
  const add = (severity: AutomationYamlSeverity, path: string, message: string) => issues.push({ severity, path, message });

  if (!hasLine(yaml, /^version:\s*1\s*$/)) add('error', 'version', 'version: 1 이 필요합니다.');
  if (!hasLine(yaml, /^name:\s*\S+/)) add('error', 'name', '자동화 이름이 필요합니다.');

  for (const section of ['trigger', 'run', 'condition', 'ai', 'report']) {
    if (!hasLine(yaml, new RegExp(`^${section}:\\s*$`))) add('error', section, `${section}: 섹션이 필요합니다.`);
  }

  const trigger = sectionBody(yaml, 'trigger');
  if (trigger) {
    if (!/^\s*type:\s*(time|webhook|manual|file_change|automation_result)\s*$/m.test(trigger)) {
      add('error', 'trigger.type', 'trigger.type은 time, webhook, manual, file_change, automation_result 중 하나여야 합니다.');
    }
    if (/^\s*type:\s*time\s*$/m.test(trigger) && !/^\s*(every|schedule|once_at):\s*\S+/m.test(trigger)) {
      add('error', 'trigger', 'time trigger는 every, schedule, once_at 중 하나가 필요합니다.');
    }
  }

  const run = sectionBody(yaml, 'run');
  if (run) {
    if (!/^\s*type:\s*(ai_prompt|command|script|webhook)\s*$/m.test(run)) {
      add('error', 'run.type', 'run.type은 ai_prompt, command, script, webhook 중 하나여야 합니다.');
    }
    if (/^\s*type:\s*command\s*$/m.test(run) && !/^\s*command:\s*\S+/m.test(run)) add('error', 'run.command', 'command 실행은 command 값이 필요합니다.');
    if (/^\s*type:\s*script\s*$/m.test(run) && !/^\s*path:\s*\S+/m.test(run)) add('error', 'run.path', 'script 실행은 path 값이 필요합니다.');
    const cwdMatch = run.match(/^\s*cwd:\s*(.+)$/m);
    if (cwdMatch && /^\//.test(cwdMatch[1].trim()) && !cwdMatch[1].trim().startsWith('/workspace')) {
      add('error', 'run.cwd', '프로젝트 자동화 cwd는 상대경로 또는 /workspace 하위여야 합니다.');
    }
    const timeoutMatch = run.match(/^\s*timeout_seconds:\s*(\d+)/m);
    if (timeoutMatch && Number(timeoutMatch[1]) > 900) add('warning', 'run.timeout_seconds', 'timeout이 15분을 넘습니다. Runbox 점유 시간이 길 수 있습니다.');
  }

  const condition = sectionBody(yaml, 'condition');
  if (condition && !/^\s*ai_when:\s*$/m.test(condition)) add('warning', 'condition.ai_when', '조건부 AI 호출을 위해 ai_when을 명시하는 것을 권장합니다.');

  const ai = sectionBody(yaml, 'ai');
  if (ai && !/^\s*(prompt_file|prompt):\s*\S+/m.test(ai)) add('warning', 'ai.prompt', 'AI가 합류할 때 사용할 prompt_file 또는 prompt를 권장합니다.');

  const report = sectionBody(yaml, 'report');
  if (report && !/^\s*policy:\s*(auto|always|on_change|on_error|silent)\s*$/m.test(report)) {
    add('warning', 'report.policy', 'report.policy는 auto, always, on_change, on_error, silent 중 하나를 권장합니다.');
  }

  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}
