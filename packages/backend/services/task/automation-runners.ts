import { isNoWorkTask } from './automation-outcome.js';
/**
 * Owns: execution adapters for generalized schedule jobs.
 * Public API: runAutomationJob(). See services/task/README.md.
 */
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { config, resolveLegacyPiModelId } from '../../config.js';
import { execute } from '../../db/pg-repo.js';
import { createTask, getTask } from './task-manager.js';
import { resolveAutomationModel } from './automation-model.js';
import { spawnTask } from './task-runner.js';
import { fireProactive } from '../ai/proactive-agent.js';
import { isRuntimeBoxEnabled } from '../runtime-box/policy.js';
import { getProject } from '../pm/project-manager.js';
import { getRunnerPolicy } from './runner-policy.js';
import { runCommandInRuntimeBox } from './runtime-box-schedule-runner.js';
import type { Automation } from './automation-manager.js';
import { executeWorkbenchRequest, type WorkbenchExecutionRequest } from '../execution/execution-broker.js';
import { createLocalWorkbenchExecutionProvider } from '../runtime-box/workbench-local-execution-provider.js';

export type AutomationRunStatus = 'success' | 'none' | 'failed' | 'timeout' | 'skipped' | 'spawned';
export type BroadcastFn = (type: string, data: any) => void;

export interface AutomationRunResult {
  status: AutomationRunStatus;
  resultId: string | null;
  stdoutText?: string | null;
  stderrText?: string | null;
  summaryText?: string | null;
  error?: string | null;
  errorJson?: Record<string, unknown> | null;
  runnerKind: 'ai' | 'host' | 'runtime_box' | 'webhook' | 'system';
  runnerRef?: string | null;
}

const MAX_CAPTURE_BYTES = 200_000;
const runningAutomationIds = new Set<string>();
const execFileAsync = promisify(execFile);

export async function runAutomationJob(automation: Automation, broadcast?: BroadcastFn): Promise<AutomationRunResult> {
  return withAutomationRunLock(automation, async () => {
    switch (automation.jobType) {
      case 'ai_prompt': return runAiPromptJob(automation, broadcast);
      case 'webhook': return runWebhookJob(automation);
      case 'shell': return runShellJob(automation);
      case 'script': return runScriptJob(automation);
      case 'monitor': return runMonitorJob(automation, broadcast);
      case 'workbench_execution': return runWorkbenchExecutionJob(automation);
      default: return runUnsupportedJob(String((automation as any).jobType));
    }
  });
}

/** Run only the non-AI observe step for Workbench testing. Never spawns AI tasks. */
export async function runAutomationObserveOnly(automation: Automation): Promise<AutomationRunResult> {
  return withAutomationRunLock(automation, async () => {
    switch (automation.jobType) {
      case 'shell': return runShellJob(automation);
      case 'script': return runScriptJob(automation);
      case 'webhook': return runWebhookJob(automation);
      case 'workbench_execution': return runWorkbenchExecutionJob(automation);
      case 'ai_prompt':
        return {
          status: 'skipped',
          resultId: null,
          summaryText: 'AI prompt automations have no separate observe step yet',
          error: null,
          errorJson: { jobType: automation.jobType },
          runnerKind: 'system',
        };
      case 'monitor':
        return {
          status: 'skipped',
          resultId: null,
          summaryText: 'Monitor observe-only dry-run is not implemented yet',
          error: null,
          errorJson: { jobType: automation.jobType },
          runnerKind: 'system',
        };
      default: return runUnsupportedJob(String((automation as any).jobType));
    }
  });
}

async function withAutomationRunLock(automation: Automation, fn: () => Promise<AutomationRunResult>): Promise<AutomationRunResult> {
  if (runningAutomationIds.has(automation.id)) {
    return {
      status: 'skipped',
      resultId: null,
      summaryText: 'Skipped because this automation is already running',
      error: 'automation already running',
      errorJson: { automationId: automation.id },
      runnerKind: 'system',
    };
  }
  runningAutomationIds.add(automation.id);
  try {
    return await fn();
  } finally {
    runningAutomationIds.delete(automation.id);
  }
}

async function runAiPromptJob(automation: Automation, broadcast?: BroadcastFn): Promise<AutomationRunResult> {
  const mode = automation.mode || 'spawn';
  const prompt = automation.prompt || String((automation.definitionJson as any).prompt || automation.description || automation.name);
  const configuredModel = automation.model || String((automation.definitionJson as any).model || 'preset/core');
  const model = resolveLegacyPiModelId(resolveAutomationModel(configuredModel));

  if (mode === 'spawn') {
    if (!broadcast) throw new Error('spawn mode requires scheduler broadcast function');
    const cwd = await resolveAutomationAiCwd(automation);
    const task = await createTask(
      automation.name,
      prompt,
      cwd,
      automation.userId,
      model,
      undefined,
      (automation.workflow || 'default') as any,
      undefined,
      automation.projectId || undefined,
      undefined,
      'silent',
    );
    // Background schedules create tasks without an active user's POST response.
    // Broadcast the new task before spawn/progress events so clients can resolve
    // titles and project grouping instead of showing "unknown task" / temp bucket.
    broadcast('task_created', { task });
    // spawnTask resolves automation.userId's DB role when no live actor role is
    // supplied, preserving scheduled run-as authority instead of defaulting to member.
    await spawnTask(task.id, broadcast, automation.userId, undefined, undefined, { waitForCompletion: true });
    // spawnTask awaits the engine to termination; read its persisted outcome.
    const completed = await getTask(task.id);
    const success = completed?.status === 'done';
    return {
      status: success ? (isNoWorkTask(completed) ? 'none' : 'success') : 'failed', resultId: task.id,
      summaryText: completed?.progressSummary?.join('\n') || `AI task ${success ? 'completed' : 'did not complete'}: ${task.id}`,
      error: success ? null : `AI task ended with status ${completed?.status || 'unknown'}`,
      runnerKind: 'ai', runnerRef: completed?.sessionId ? `completed-session:${completed.sessionId}` : `completed-task:${task.id}`,
    };
  }

  if (mode === 'inject') {
    if (!automation.targetId) throw new Error('inject mode requires target_id (session_id)');
    const result = await fireProactive(
      automation.userId,
      { id: `automation-${automation.id}`, name: automation.name, prompt, model, projectId: automation.projectId || undefined },
      { summary: `스케줄 실행: ${automation.name}`, triggerMeta: { automationId: automation.id } },
      {
        targetSessionId: automation.targetId,
        automationId: automation.id,
        suppressCompletionNotification: true,
      },
    );
    return { status: 'success', resultId: result.sessionId, summaryText: `Injected into session: ${result.sessionId}`, runnerKind: 'ai', runnerRef: result.sessionId };
  }

  if (mode === 'channel') {
    // Legacy compatibility: execute old rows in a new Session, but never write
    // back to chat_rooms. The caller emits an Automation Notification.
    const result = await fireProactive(
      automation.userId,
      { id: `automation-${automation.id}`, name: automation.name, prompt, model, projectId: automation.projectId || undefined },
      { summary: `스케줄 실행: ${automation.name}`, triggerMeta: { automationId: automation.id, legacyMode: 'channel' } },
      { automationId: automation.id, suppressCompletionNotification: true },
    );
    return { status: 'success', resultId: result.sessionId, summaryText: result.firstMessage || `Automation session: ${result.sessionId}`, runnerKind: 'ai', runnerRef: result.sessionId };
  }

  throw new Error(`Unknown AI automation mode: ${mode}`);
}

async function runMonitorJob(automation: Automation, broadcast?: BroadcastFn): Promise<AutomationRunResult> {
  const def = automation.definitionJson as any;
  const monitorType = String(def.monitorType || def.type || '');

  if (monitorType === 'github_new_issues') {
    return runGitHubNewIssuesMonitor(automation, broadcast);
  }

  return runUnsupportedJob(`monitor:${monitorType || 'unknown'}`);
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  author: string | null;
  body: string;
}

export interface GitHubNewIssuesSelection {
  issues: GitHubIssueSummary[];
  newIssues: GitHubIssueSummary[];
  baselineIssueNumber: number;
  processedIssueNumbers: number[];
  skippedByBaseline: number[];
  skippedByProcessed: number[];
  highestFetchedIssueNumber: number;
  oldestFetchedIssueNumber: number | null;
  newestFetchedIssueNumber: number | null;
  oldestFetchedCreatedAt: string | null;
  newestFetchedCreatedAt: string | null;
}

export function normalizeGitHubIssueFetchLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

export function selectNewGitHubIssues(
  issues: GitHubIssueSummary[],
  baselineIssueNumber: number,
  processedNumbers: Set<number>,
): GitHubNewIssuesSelection {
  const sortedByNumber = [...issues].sort((a, b) => a.number - b.number);
  const skippedByBaseline = sortedByNumber
    .filter((issue) => issue.number <= baselineIssueNumber)
    .map((issue) => issue.number);
  const skippedByProcessed = sortedByNumber
    .filter((issue) => issue.number > baselineIssueNumber && processedNumbers.has(issue.number))
    .map((issue) => issue.number);
  const newIssues = sortedByNumber
    .filter((issue) => issue.number > baselineIssueNumber && !processedNumbers.has(issue.number));
  const sortedByCreatedAt = [...issues].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const oldestFetched = sortedByCreatedAt[0] || null;
  const newestFetched = sortedByCreatedAt[sortedByCreatedAt.length - 1] || null;

  return {
    issues,
    newIssues,
    baselineIssueNumber,
    processedIssueNumbers: Array.from(processedNumbers).sort((a, b) => a - b),
    skippedByBaseline,
    skippedByProcessed,
    highestFetchedIssueNumber: Math.max(baselineIssueNumber, ...issues.map((issue) => issue.number), 0),
    oldestFetchedIssueNumber: sortedByNumber[0]?.number ?? null,
    newestFetchedIssueNumber: sortedByNumber[sortedByNumber.length - 1]?.number ?? null,
    oldestFetchedCreatedAt: oldestFetched?.createdAt || null,
    newestFetchedCreatedAt: newestFetched?.createdAt || null,
  };
}

async function runGitHubNewIssuesMonitor(automation: Automation, broadcast?: BroadcastFn): Promise<AutomationRunResult> {
  if (!broadcast) throw new Error('github_new_issues monitor requires scheduler broadcast function');

  const def = { ...(automation.definitionJson as any), ...(automation.runtimeStateJson as any) };
  const repo = String(def.repo || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`github_new_issues monitor requires owner/repo, got: ${repo || '(empty)'}`);
  }

  const limitRuns = Number.isFinite(Number(def.limitRuns)) ? Math.max(1, Number(def.limitRuns)) : null;
  const currentPolls = Number.isFinite(Number(def.pollCount)) ? Math.max(0, Number(def.pollCount)) : 0;
  const baselineIssueNumber = Number.isFinite(Number(def.baselineIssueNumber)) ? Number(def.baselineIssueNumber) : 0;
  const processedNumbers = Array.isArray(def.processedIssueNumbers)
    ? new Set<number>(def.processedIssueNumbers.map((n: any) => Number(n)).filter(Number.isFinite))
    : new Set<number>();

  const fetchLimit = normalizeGitHubIssueFetchLimit(def.fetchLimit);
  const selection = selectNewGitHubIssues(
    await fetchOpenGitHubIssues(repo, fetchLimit),
    baselineIssueNumber,
    processedNumbers,
  );
  const { issues, newIssues } = selection;

  const taskIds: string[] = [];
  for (const issue of newIssues) {
    const task = await createTask(
      `GitHub issue #${issue.number} 리서치: ${issue.title}`,
      buildIssueResearchPrompt(repo, issue),
      automation.cwd || await resolveProjectCwd(automation),
      automation.userId,
      resolveLegacyPiModelId(resolveAutomationModel(String(def.model || automation.model || 'preset/core'))),
      undefined,
      'auto',
      undefined,
      automation.projectId || undefined,
      undefined,
      'silent',
    );
    broadcast('task_created', { task });
    // Background monitor tasks run as the automation owner; task-runner resolves
    // that user's current role from DB so admin-owned monitors are not downgraded.
    spawnTask(task.id, broadcast, automation.userId);
    taskIds.push(task.id);
    processedNumbers.add(issue.number);
  }

  const nextPollCount = currentPolls + 1;
  const shouldDisable = !!limitRuns && nextPollCount >= limitRuns;
  const nextRuntimeState = {
    ...(automation.runtimeStateJson as Record<string, unknown>),
    pollCount: nextPollCount,
    processedIssueNumbers: Array.from(processedNumbers).sort((a, b) => a - b),
    lastCheckedAt: new Date().toISOString(),
    lastSeenIssueNumber: selection.highestFetchedIssueNumber,
    lastSeenIssueCreatedAt: selection.newestFetchedCreatedAt,
    oldestFetchedIssueNumber: selection.oldestFetchedIssueNumber,
    oldestFetchedIssueCreatedAt: selection.oldestFetchedCreatedAt,
  };

  await execute(
    `UPDATE automations
       SET runtime_state_json = $1::jsonb,
           enabled = CASE WHEN $2 THEN false ELSE enabled END,
           next_run_at = CASE WHEN $2 THEN NULL ELSE next_run_at END
     WHERE id = $3`,
    [JSON.stringify(nextRuntimeState), shouldDisable, automation.id],
  );

  const fetchLimitWarning = issues.length >= fetchLimit
    ? ' Fetch limit reached; older open issues may be outside this poll window.'
    : '';
  const summary = newIssues.length > 0
    ? `Detected ${newIssues.length} new issue(s): ${newIssues.map((issue) => `#${issue.number}`).join(', ')}. Spawned ${taskIds.length} research task(s). Poll ${nextPollCount}${limitRuns ? `/${limitRuns}` : ''}. Fetched ${issues.length}/${fetchLimit}, skipped baseline ${selection.skippedByBaseline.length}, skipped processed ${selection.skippedByProcessed.length}.${fetchLimitWarning}`
    : `No new issue. Poll ${nextPollCount}${limitRuns ? `/${limitRuns}` : ''}. Fetched ${issues.length}/${fetchLimit}, skipped baseline ${selection.skippedByBaseline.length}, skipped processed ${selection.skippedByProcessed.length}.${shouldDisable ? ' Disabled after reaching test limit.' : ''}${fetchLimitWarning}`;

  return {
    status: newIssues.length > 0 ? 'success' : 'none',
    resultId: taskIds[0] || null,
    stdoutText: JSON.stringify({
      repo,
      fetchLimit,
      fetchedIssueNumbers: issues.map((issue) => issue.number).sort((a, b) => a - b),
      baselineIssueNumber,
      processedIssueNumbers: selection.processedIssueNumbers,
      skippedByBaseline: selection.skippedByBaseline,
      skippedByProcessed: selection.skippedByProcessed,
      newIssues: newIssues.map((issue) => issue.number),
      taskIds,
      pollCount: nextPollCount,
      disabled: shouldDisable,
      lastSeenIssueNumber: selection.highestFetchedIssueNumber,
      lastSeenIssueCreatedAt: selection.newestFetchedCreatedAt,
      oldestFetchedIssueNumber: selection.oldestFetchedIssueNumber,
      oldestFetchedIssueCreatedAt: selection.oldestFetchedCreatedAt,
      fetchLimitReached: issues.length >= fetchLimit,
    }, null, 2),
    summaryText: summary,
    runnerKind: 'system',
    runnerRef: repo,
  };
}

async function fetchOpenGitHubIssues(repo: string, limit: number): Promise<GitHubIssueSummary[]> {
  const args = ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(Math.min(Math.max(limit, 1), 100)), '--json', 'number,title,url,createdAt,author,body'];
  const { stdout } = await execFileAsync('gh', args, {
    timeout: 20_000,
    maxBuffer: MAX_CAPTURE_BYTES,
    env: process.env,
  });
  const parsed = JSON.parse(stdout || '[]');
  if (!Array.isArray(parsed)) return [];
  return parsed.map((row: any) => ({
    number: Number(row.number),
    title: String(row.title || ''),
    url: String(row.url || `https://github.com/${repo}/issues/${row.number}`),
    createdAt: String(row.createdAt || ''),
    author: row.author?.login ? String(row.author.login) : null,
    body: String(row.body || ''),
  })).filter((issue) => Number.isFinite(issue.number));
}

export function buildIssueResearchPrompt(repo: string, issue: GitHubIssueSummary): string {
  const bodyPreview = issue.body.length > 12_000 ? `${issue.body.slice(0, 12_000)}\n\n...[truncated]` : issue.body;
  return `목표: GitHub issue #${issue.number}를 살펴보고, 사용자가 “오케이”를 누르면 바로 고칠 수 있을 만큼 실행 가능한 수정 계획서를 만든다.\n\nRepo: ${repo}\nIssue: ${issue.url}\nTitle: ${issue.title}\nAuthor: ${issue.author || 'unknown'}\nCreated: ${issue.createdAt}\n\nIssue body:\n${bodyPreview || '(empty)'}\n\n작업 방식:\n- 저장소 안에서 실제로 수정할 수 있는 파일·함수·설정·문서 후보를 찾아라. 단순 의견이 아니라 “바로 손댈 수 있는 지점”까지 좁혀라.\n- 필요한 경우 관련 문서, 결정문서, 테스트, 최근 유사 구현을 함께 확인하라.\n- 수정은 아직 하지 말고, 사용자가 선택·승인하면 즉시 실행할 수 있는 형태로 준비하라.\n\n요구 산출물:\n1. 문제 요약 — 이 이슈가 무엇을 불편하게 만드는지 한 문단으로 설명\n2. 즉시 수정 가능한 지점 — 파일 경로, 함수/컴포넌트/설정명, 왜 그곳인지\n3. 확인한 근거 — 읽은 코드/문서/로그와 관찰한 사실\n4. 수정 계획서 — 단계별 작업 순서, 예상 변경 파일, 필요한 테스트/검증\n5. 선택지 — 최소 2개 옵션(빠른 패치 / 구조적 개선 등)과 각 장단점, 권장안\n6. 우리에게 미칠 임팩트 — 사용자 경험, 운영/배포, 데이터/권한, 기존 워크플로, 회귀 위험\n7. 승인 후 바로 실행할 액션 — “오케이”를 받으면 어떤 옵션을 어떤 순서로 실행할지 체크리스트\n8. 남은 질문 — 정말 막히는 의사결정만 0~3개로 제한\n\n보고 형식:\n- 맨 위에 \`권장 선택: <옵션명>\`을 써라.\n- 사용자가 바로 고를 수 있게 옵션마다 \`선택하면 할 일\`, \`예상 영향\`, \`검증 방법\`을 붙여라.\n- 파일 경로는 가능한 한 정확히 적어라. 추측이면 \`추정\`이라고 표시하라.\n\n제약:\n- 코드 수정, 커밋, 배포는 하지 말고 리서치와 수정 계획 작성까지만 수행한다.\n- secret/token 값을 출력하지 않는다.\n- 이슈 내용이 민감해 보이면 외부 검색보다 저장소 내부 코드/문서 확인을 우선한다.\n- 승인 대기 상태로 끝내라. “오케이” 전에는 저장소를 변경하지 않는다.`;
}

async function runWebhookJob(automation: Automation): Promise<AutomationRunResult> {
  const def = automation.definitionJson as any;
  const url = String(def.url || '');
  if (!url) throw new Error('webhook job requires definition_json.url');

  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported webhook protocol: ${parsed.protocol}`);
  }

  const method = String(def.method || 'GET').toUpperCase();
  const controller = new AbortController();
  const timeoutMs = Math.max(1, automation.timeoutSeconds ?? 30) * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method,
      headers: typeof def.headers === 'object' && def.headers ? def.headers : undefined,
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(def.body ?? {}),
      signal: controller.signal,
    });
    const text = (await res.text()).slice(0, 20_000);
    const summary = `${method} ${url} → HTTP ${res.status} (${Date.now() - started}ms)`;
    return {
      status: res.status >= 400 ? 'failed' : 'success',
      resultId: null,
      stdoutText: text,
      summaryText: summary,
      error: res.status >= 400 ? summary : null,
      errorJson: res.status >= 400 ? { status: res.status, statusText: res.statusText } : null,
      runnerKind: 'webhook',
      runnerRef: url,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { status: 'timeout', resultId: null, error: `webhook timed out after ${timeoutMs}ms`, summaryText: 'Webhook timed out', runnerKind: 'webhook', runnerRef: url };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function runScriptJob(automation: Automation): Promise<AutomationRunResult> {
  const def = automation.definitionJson as any;
  const scriptPath = String(def.path || '');
  if (!scriptPath) throw new Error('script job requires definition_json.path');
  const args = Array.isArray(def.args) ? def.args.map(String) : [];
  const command = [scriptPath, ...args].map(shellQuote).join(' ');
  return runShellCommand(automation, command, def.cwd ? String(def.cwd) : undefined);
}

async function runWorkbenchExecutionJob(automation: Automation): Promise<AutomationRunResult> {
  if (!automation.projectId) throw new Error('workbench_execution requires project_id');
  const def = automation.definitionJson as any;
  const command = String(def.command || '');
  if (!command) throw new Error('workbench_execution requires definition_json.command');
  const lifecycle = String(def.lifecycle || 'auto') as WorkbenchExecutionRequest['lifecycle'];
  if (!['auto', 'foreground', 'job', 'service'].includes(lifecycle || '')) throw new Error(`unsupported Workbench lifecycle: ${lifecycle}`);
  const execution = await executeWorkbenchRequest({
    request: {
      command,
      cwd: def.cwd ? String(def.cwd) : automation.cwd || undefined,
      lifecycle,
      timeoutSec: Math.max(1, automation.timeoutSeconds ?? 60),
      service: def.service && typeof def.service === 'object' ? def.service : undefined,
    },
    context: {
      projectId: automation.projectId,
      userId: automation.userId,
      sessionId: automation.createdBySessionId || `automation:${automation.id}`,
    },
    provider: createLocalWorkbenchExecutionProvider(),
  });
  if (execution.execution.lifecycle === 'job') {
    return {
      status: 'success', resultId: String(execution.execution.job.id),
      summaryText: `Workbench Job queued: ${execution.execution.job.id}`,
      stdoutText: JSON.stringify({ plan: execution.plan, job: execution.execution.job }, null, 2),
      runnerKind: 'runtime_box', runnerRef: `workbench-job:${execution.execution.job.id}`,
    };
  }
  if (execution.execution.lifecycle === 'service') {
    return {
      status: 'success', resultId: String(execution.execution.service.id),
      summaryText: `Workbench Service started: ${execution.execution.service.name}`,
      stdoutText: JSON.stringify({ plan: execution.plan, service: execution.execution.service }, null, 2),
      runnerKind: 'runtime_box', runnerRef: `workbench-service:${execution.execution.service.id}`,
    };
  }
  const result = execution.execution.result;
  return {
    status: result.timed_out ? 'timeout' : result.exit_code === 0 ? 'success' : 'failed',
    resultId: null, stdoutText: result.stdout, stderrText: result.stderr,
    summaryText: `Workbench foreground command exited with ${result.exit_code}`,
    error: result.exit_code === 0 ? null : `exit ${result.exit_code}`,
    errorJson: result.exit_code === 0 ? null : { exitCode: result.exit_code, timedOut: result.timed_out, oomKilled: result.oom_killed },
    runnerKind: 'runtime_box', runnerRef: 'workbench-foreground',
  };
}

async function runShellJob(automation: Automation): Promise<AutomationRunResult> {
  const def = automation.definitionJson as any;
  const command = String(def.command || '');
  if (!command) throw new Error('shell job requires definition_json.command');
  return runShellCommand(automation, command, def.cwd ? String(def.cwd) : undefined);
}

async function runShellCommand(automation: Automation, command: string, cwdOverride?: string): Promise<AutomationRunResult> {
  const policy = getRunnerPolicy(automation.definitionJson);
  const shouldUseRuntimeBox = !!automation.projectId && (
    policy.preference === 'runtime_box' ||
    (policy.preference === 'auto' && isRuntimeBoxEnabled() && automation.scopeType === 'project')
  );

  if (shouldUseRuntimeBox) {
    try {
      const result = await runCommandInRuntimeBox({
        projectId: automation.projectId!,
        userId: automation.userId,
        command,
        cwd: cwdOverride || automation.cwd || '.',
        timeoutSeconds: Math.max(1, automation.timeoutSeconds ?? 60),
        policy,
        boxSelector: policy.boxSelector,
      });
      return {
        status: result.status,
        resultId: null,
        stdoutText: result.stdoutText,
        stderrText: result.stderrText,
        summaryText: `Runtime Box command exited with ${result.exitCode ?? 'unknown'}`,
        error: result.error,
        errorJson: result.error ? { exitCode: result.exitCode } : null,
        runnerKind: 'runtime_box',
        runnerRef: result.runnerRef,
      };
    } catch (err: any) {
      if (policy.fallback !== 'admin_host' || automation.scopeType !== 'system') {
        return {
          status: 'failed',
          resultId: null,
          error: err.message,
          summaryText: `Runtime Box runner failed: ${err.message}`,
          errorJson: { message: err.message, fallback: policy.fallback },
          runnerKind: 'runtime_box',
        };
      }
      // Explicit system-job escape hatch only. Never silently fallback for project jobs.
    }
  }

  const cwd = await resolveSafeCwd(automation, cwdOverride || automation.cwd || undefined);
  const timeoutMs = Math.max(1, automation.timeoutSeconds ?? 60) * 1000;

  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-MAX_CAPTURE_BYTES);
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: 'failed',
        resultId: null,
        stdoutText: stdout || null,
        stderrText: stderr || err.message,
        summaryText: `Command failed to start: ${err.message}`,
        error: err.message,
        errorJson: { message: err.message, cwd, command },
        runnerKind: 'host',
        runnerRef: cwd,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status: AutomationRunStatus = timedOut ? 'timeout' : code === 0 ? 'success' : 'failed';
      resolve({
        status,
        resultId: null,
        stdoutText: stdout || null,
        stderrText: stderr || null,
        summaryText: `Command exited with ${code ?? signal ?? 'unknown'}`,
        error: status === 'success' ? null : `Command exited with ${code ?? signal ?? 'unknown'}`,
        errorJson: status === 'success' ? null : { exitCode: code, signal, timedOut },
        runnerKind: 'host',
        runnerRef: cwd,
      });
    });
  });
}

/** Shared by legacy and Execution Control Plane AI dispatch. */
export async function resolveAutomationAiCwd(automation: Automation): Promise<string> {
  return automation.projectId && automation.scopeType !== 'system'
    ? resolveSafeCwd(automation, automation.cwd || undefined)
    : automation.cwd || await resolveProjectCwd(automation);
}

async function resolveProjectCwd(automation: Automation): Promise<string> {
  if (!automation.projectId) return path.resolve(config.workspaceRoot);
  const project = await getProject(automation.projectId);
  if (!project?.rootPath || project.archived || project.lifecycleStatus === 'retired') {
    throw new Error('Automation Project is unavailable; refusing to substitute another workspace');
  }
  return path.resolve(project.rootPath);
}

async function resolveSafeCwd(automation: Automation, cwd?: string): Promise<string> {
  const base = await resolveProjectCwd(automation);
  const raw = cwd || base;
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  if (automation.scopeType !== 'system' && !(resolved === base || resolved.startsWith(base + path.sep))) {
    throw new Error(`command cwd escapes project scope: ${resolved}`);
  }
  return resolved;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runUnsupportedJob(type: string): Promise<AutomationRunResult> {
  return {
    status: 'failed',
    resultId: null,
    error: `Job type not implemented yet: ${type}`,
    summaryText: `Job type not implemented yet: ${type}`,
    runnerKind: 'system',
  };
}
