/**
 * Owns: Process Map MVP projection for schedule/automation runs.
 * Public API: appendProcessEvent, getAutomationRunProcessMap, getSessionProcessMap, getAutomationProcessEvents.
 * See: workspace/decisions/2026-06-29-process-map-separate-from-todowrite.md
 */

import { automationResultSessionId, isUnverifiedAiSpawn } from '../task/automation-result-reference.js';
import { canAccessSession } from '../pm/project-access.js';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../../db/pg-repo.js';
import type { Automation, AutomationRun } from '../task/automation-manager.js';

export type ProcessEventSourceType = 'todowrite' | 'tool_call' | 'artifact' | 'automation_run' | 'agent_report' | 'command_invocation' | 'skill_invocation' | 'user_decision' | 'system';
export type ProcessEventType = 'step_started' | 'step_completed' | 'step_failed' | 'artifact_created' | 'approval_requested' | 'decision_made' | 'blocked' | 'unblocked';
export type ProcessNodeKind = 'user_intent' | 'data_input' | 'ai_step' | 'tool_step' | 'command' | 'skill' | 'human_review' | 'decision' | 'artifact' | 'blocker' | 'automation_candidate';
export type ProcessNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
export type ProcessOwner = 'ai' | 'human' | 'system' | 'external';
export type AutomationLevel = 'manual' | 'assisted' | 'semi_auto' | 'auto';
export type ProcessEdgeRelation = 'depends_on' | 'produces' | 'reviews' | 'triggers' | 'blocks' | 'summarizes';

export interface ProcessEvent {
  id: string;
  projectId: string | null;
  sessionId: string | null;
  automationId: string | null;
  runId: string | null;
  executionId: string | null;
  sourceType: ProcessEventSourceType;
  sourceId: string | null;
  eventType: ProcessEventType;
  rawLabel: string | null;
  rawPayload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface ProcessNode {
  id: string;
  label: string;
  kind: ProcessNodeKind;
  status: ProcessNodeStatus;
  owner: ProcessOwner;
  automationLevel: AutomationLevel;
  summary?: string;
  evidence?: {
    eventIds?: string[];
    files?: string[];
    toolCalls?: string[];
    sessionIds?: string[];
    logs?: string[];
  };
}

export interface ProcessEdge {
  id: string;
  from: string;
  to: string;
  relation: ProcessEdgeRelation;
}

export interface ProcessMap {
  id: string;
  title: string;
  projectId: string | null;
  source: 'task' | 'schedule' | 'chat' | 'agent_run' | 'workflow';
  abstractionLevel: 'run' | 'workflow' | 'organization';
  status: 'draft' | 'running' | 'paused' | 'completed' | 'failed' | 'blocked';
  sourceRefs: Record<string, unknown>;
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  createdAt: string;
  updatedAt: string;
}

function mapEventRow(row: any): ProcessEvent {
  return {
    id: row.id,
    projectId: row.project_id || null,
    sessionId: row.session_id || null,
    automationId: row.automation_id || null,
    runId: row.run_id || null,
    executionId: row.execution_id || null,
    sourceType: row.source_type,
    sourceId: row.source_id || null,
    eventType: row.event_type,
    rawLabel: row.raw_label || null,
    rawPayload: row.raw_payload || {},
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function mapProcessMapRow(row: any): ProcessMap {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id || null,
    source: row.source,
    abstractionLevel: row.abstraction_level,
    status: row.status,
    sourceRefs: row.source_refs || {},
    nodes: row.nodes || [],
    edges: row.edges || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function appendProcessEvent(params: {
  projectId?: string | null;
  sessionId?: string | null;
  automationId?: string | null;
  runId?: string | null;
  executionId?: string | null;
  sourceType: ProcessEventSourceType;
  sourceId?: string | null;
  eventType: ProcessEventType;
  rawLabel?: string | null;
  rawPayload?: Record<string, unknown>;
  occurredAt?: string;
}): Promise<ProcessEvent> {
  const id = uuidv4();
  const row = await queryOne<any>(`
    INSERT INTO process_events (
      id, project_id, session_id, automation_id, run_id, execution_id,
      source_type, source_id, event_type, raw_label, raw_payload, occurred_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, NOW()))
    RETURNING *
  `, [
    id,
    params.projectId || null,
    params.sessionId || null,
    params.automationId || null,
    params.runId || null,
    params.executionId || null,
    params.sourceType,
    params.sourceId || null,
    params.eventType,
    params.rawLabel || null,
    JSON.stringify(params.rawPayload || {}),
    params.occurredAt || null,
  ]);
  return mapEventRow(row);
}

export async function getAutomationProcessEvents(automationId: string, limit = 100): Promise<ProcessEvent[]> {
  const rows = await query<any>(`
    SELECT * FROM process_events
    WHERE automation_id = $1
    ORDER BY occurred_at DESC
    LIMIT $2
  `, [automationId, limit]);
  return rows.map(mapEventRow);
}

export async function getPersistedProcessMap(id: string): Promise<ProcessMap | null> {
  const row = await queryOne<any>('SELECT * FROM process_maps WHERE id = $1', [id]);
  return row ? mapProcessMapRow(row) : null;
}

function inferRunStatus(run: AutomationRun): ProcessMap['status'] {
  if (run.status === 'success' || run.status === 'none') return 'completed';
  if (run.status === 'failed' || run.status === 'aborted') return 'failed';
  return 'running';
}

function inferOwner(automation: Automation): ProcessOwner {
  if (automation.jobType === 'webhook') return 'external';
  if (automation.jobType === 'shell' || automation.jobType === 'script' || automation.jobType === 'monitor') return 'system';
  return 'ai';
}

function inferAutomationLevel(automation: Automation): AutomationLevel {
  if (automation.triggerType === 'manual') return 'assisted';
  if (automation.jobType === 'ai_prompt') return 'semi_auto';
  return 'auto';
}

function eventStatus(events: ProcessEvent[]): ProcessNodeStatus {
  if (events.some((event) => event.eventType === 'step_failed')) return 'failed';
  if (events.some((event) => event.eventType === 'step_completed')) return 'completed';
  if (events.some((event) => event.eventType === 'blocked')) return 'blocked';
  return 'running';
}

function groupEventsBySource(events: ProcessEvent[], sourceType: ProcessEventSourceType): Array<[string, ProcessEvent[]]> {
  const grouped = new Map<string, ProcessEvent[]>();
  for (const event of events.filter((item) => item.sourceType === sourceType)) {
    const key = event.sourceId || event.id;
    grouped.set(key, [...(grouped.get(key) || []), event]);
  }
  return [...grouped.entries()];
}

function buildCommandInvocationNodes(events: ProcessEvent[]): ProcessNode[] {
  return groupEventsBySource(events, 'command_invocation').map(([sourceId, commandEvents]) => {
    const first = commandEvents[0];
    const latest = commandEvents[commandEvents.length - 1] || first;
    const payload = latest.rawPayload || first.rawPayload || {};
    const displayName = String(payload.displayName || payload.canonicalCommand || first.rawLabel || 'Command');
    const commandKind = payload.commandKind ? `kind=${payload.commandKind}` : null;
    const trigger = payload.trigger ? `trigger=${payload.trigger}` : null;
    const phase = payload.phase ? `phase=${payload.phase}` : null;
    return {
      id: `command:${sourceId.replace(/[^a-zA-Z0-9_.:-]/g, '-')}`,
      label: `Command · ${displayName}`,
      kind: 'command',
      status: eventStatus(commandEvents),
      owner: payload.commandKind === 'skill' ? 'ai' : 'system',
      automationLevel: payload.commandKind === 'native' ? 'auto' : 'assisted',
      summary: [commandKind, trigger, phase].filter(Boolean).join(' · ') || undefined,
      evidence: {
        eventIds: commandEvents.map((event) => event.id),
        sessionIds: first.sessionId ? [first.sessionId] : undefined,
        logs: commandEvents.map((event) => event.rawLabel).filter((label): label is string => Boolean(label)).slice(0, 5),
      },
    } satisfies ProcessNode;
  });
}

function buildSkillInvocationNodes(events: ProcessEvent[]): ProcessNode[] {
  return groupEventsBySource(events, 'skill_invocation').map(([sourceId, skillEvents]) => {
    const first = skillEvents[0];
    const latest = skillEvents[skillEvents.length - 1] || first;
    const payload = latest.rawPayload || first.rawPayload || {};
    const displayName = String(payload.displayName || payload.skillName || first.rawLabel || 'Skill');
    const trigger = payload.trigger ? `trigger=${payload.trigger}` : null;
    const source = payload.source ? `source=${payload.source}` : null;
    const phase = payload.phase ? `phase=${payload.phase}` : null;
    return {
      id: `skill:${sourceId.replace(/[^a-zA-Z0-9_.:-]/g, '-')}`,
      label: `Skill · ${displayName}`,
      kind: 'skill',
      status: eventStatus(skillEvents),
      owner: 'ai',
      automationLevel: 'assisted',
      summary: [trigger, source, phase].filter(Boolean).join(' · ') || undefined,
      evidence: {
        eventIds: skillEvents.map((event) => event.id),
        sessionIds: first.sessionId ? [first.sessionId] : undefined,
        logs: skillEvents.map((event) => event.rawLabel).filter((label): label is string => Boolean(label)).slice(0, 5),
      },
    } satisfies ProcessNode;
  });
}

function runEvidence(run: AutomationRun, events: ProcessEvent[], automation: Automation): ProcessNode['evidence'] {
  const logs = [run.summaryText, run.error, run.stdoutText, run.stderrText]
    .filter((v): v is string => Boolean(v && v.trim()))
    .slice(0, 3);
  return {
    eventIds: events.map((e) => e.id).slice(0, 20),
    sessionIds: automationResultSessionId(run, automation) ? [automationResultSessionId(run, automation)!] : undefined,
    logs: logs.length ? logs : undefined,
  };
}

function parseWorkflowStepMarkers(run: AutomationRun): ProcessNode[] {
  const text = run.stdoutText || '';
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const markerLines = lines.filter((line) => line.startsWith('PROCESS_STEP '));

  return markerLines.map((line, index) => {
    const payload = line.slice('PROCESS_STEP '.length);
    try {
      const parsed = JSON.parse(payload) as Partial<ProcessNode> & { summary?: string };
      const status = parsed.status || 'completed';
      return {
        id: parsed.id || `step-${index + 1}`,
        label: parsed.label || `단계 ${index + 1}`,
        kind: parsed.kind || 'tool_step',
        status,
        owner: parsed.owner || 'system',
        automationLevel: parsed.automationLevel || 'auto',
        summary: parsed.summary,
        evidence: { logs: [line] },
      } satisfies ProcessNode;
    } catch {
      return {
        id: `step-${index + 1}`,
        label: payload || `단계 ${index + 1}`,
        kind: 'tool_step',
        status: 'completed',
        owner: 'system',
        automationLevel: 'auto',
        evidence: { logs: [line] },
      } satisfies ProcessNode;
    }
  });
}

function buildLinearEdges(nodes: ProcessNode[], failed: boolean): ProcessEdge[] {
  return nodes.slice(0, -1).map((node, index) => {
    const next = nodes[index + 1];
    return {
      id: `${node.id}-${next.id}`,
      from: node.id,
      to: next.id,
      relation: failed && next.kind === 'blocker' ? 'blocks' : 'triggers',
    } satisfies ProcessEdge;
  });
}

function firstEventTimeForNode(node: ProcessNode, events: ProcessEvent[]): number {
  const firstEventId = node.evidence?.eventIds?.[0];
  const event = firstEventId ? events.find((item) => item.id === firstEventId) : null;
  return event ? new Date(event.occurredAt).getTime() : 0;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return items.length ? items : undefined;
}

function processMapWriteNodeKind(step: any): ProcessNodeKind {
  if (step?.kind && typeof step.kind === 'string') {
    const allowed: ProcessNodeKind[] = ['user_intent', 'data_input', 'ai_step', 'tool_step', 'command', 'skill', 'human_review', 'decision', 'artifact', 'blocker', 'automation_candidate'];
    if (allowed.includes(step.kind)) return step.kind;
  }
  if (Array.isArray(step?.needs) && step.needs.length > 0) return 'data_input';
  if (step?.status === 'blocked' || step?.status === 'failed') return 'blocker';
  if (step?.evidence?.artifacts?.length || step?.output) return 'artifact';
  return 'ai_step';
}

function processMapWriteStatus(status: unknown): ProcessNodeStatus {
  if (status === 'pending' || status === 'running' || status === 'completed' || status === 'failed' || status === 'blocked' || status === 'skipped') return status;
  return 'pending';
}

function processMapWriteOwner(owner: unknown): ProcessOwner {
  if (owner === 'ai' || owner === 'human' || owner === 'system' || owner === 'external') return owner;
  return 'ai';
}

function processMapWriteOverallStatus(status: unknown, nodes: ProcessNode[]): ProcessMap['status'] {
  if (status === 'draft' || status === 'running' || status === 'paused' || status === 'completed' || status === 'failed' || status === 'blocked') return status;
  if (nodes.some((node) => node.status === 'failed')) return 'failed';
  if (nodes.some((node) => node.status === 'blocked')) return 'blocked';
  if (nodes.some((node) => node.status === 'running')) return 'running';
  if (nodes.length > 0 && nodes.every((node) => node.status === 'completed' || node.status === 'skipped')) return 'completed';
  return 'draft';
}

function parseAssistantContentBlocks(content: string): any[] {
  try {
    const parsed = JSON.parse(content || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function getLatestProcessMapWrite(args: { sessionId: string; projectId?: string | null; title?: string | null }): Promise<ProcessMap | null> {
  const rows = await query<{ id: string; content: string; created_at: string }>(`
    SELECT id, content, created_at::text AS created_at
    FROM messages
    WHERE session_id = $1 AND role = 'assistant' AND content LIKE '%ProcessMapWrite%'
    ORDER BY created_at DESC
    LIMIT 10
  `, [args.sessionId]);

  for (const row of rows) {
    const blocks = parseAssistantContentBlocks(row.content);
    for (const block of [...blocks].reverse()) {
      if (block?.type !== 'tool_use' || block?.name !== 'ProcessMapWrite') continue;
      const input = block.input || {};
      if (!Array.isArray(input.steps) || input.steps.length === 0) continue;
      const nodes: ProcessNode[] = input.steps.map((step: any, index: number) => {
        const evidence = step?.evidence || {};
        const needs = stringArray(step?.needs);
        const output = typeof step?.output === 'string' && step.output.trim() ? `Output: ${step.output}` : null;
        const needsLog = needs?.length ? `Needs: ${needs.join(', ')}` : null;
        return {
          id: `pmw:${String(step?.id || `step-${index + 1}`).replace(/[^a-zA-Z0-9_.:-]/g, '-')}`,
          label: String(step?.label || `Step ${index + 1}`),
          kind: processMapWriteNodeKind(step),
          status: processMapWriteStatus(step?.status),
          owner: processMapWriteOwner(step?.owner),
          automationLevel: 'assisted',
          summary: typeof step?.summary === 'string' ? step.summary : undefined,
          evidence: {
            files: stringArray(evidence.files),
            toolCalls: stringArray(evidence.toolCalls),
            logs: [needsLog, output].filter((item): item is string => Boolean(item)),
          },
        } satisfies ProcessNode;
      });
      return {
        id: `session:${args.sessionId}:process-map-write:${row.id}`,
        title: typeof input.title === 'string' && input.title.trim() ? input.title : args.title || 'Process Map',
        projectId: args.projectId ?? null,
        source: 'chat',
        abstractionLevel: 'run',
        status: processMapWriteOverallStatus(input.status, nodes),
        sourceRefs: {
          sessionIds: [args.sessionId],
          source: 'ProcessMapWrite',
          messageId: row.id,
          scope: input.scope || {},
          note: input.note,
        },
        nodes,
        edges: buildLinearEdges(nodes, nodes.some((node) => node.status === 'failed')),
        createdAt: row.created_at,
        updatedAt: row.created_at,
      };
    }
  }
  return null;
}

function buildRuntimeDraftNodes(latestExecution: ProcessNode | null): ProcessNode[] {
  if (!latestExecution) return [];
  const baseId = `${latestExecution.id}:runtime`;
  const isDone = latestExecution.status === 'completed';
  const failed = latestExecution.status === 'failed';
  const blocked = latestExecution.status === 'blocked';
  const activeStatus: ProcessNodeStatus = failed ? 'failed' : blocked ? 'blocked' : isDone ? 'completed' : 'running';
  const pendingStatus: ProcessNodeStatus = isDone ? 'completed' : 'pending';
  return [
    {
      id: `${baseId}:frame`,
      label: '요청과 실행 맥락 확인',
      kind: latestExecution.kind === 'command' ? 'command' : 'skill',
      status: activeStatus,
      owner: latestExecution.owner,
      automationLevel: latestExecution.automationLevel,
      summary: 'runtime이 이번 요청, command, 활성 skill context를 보고 진행 지도를 구성합니다.',
      evidence: latestExecution.evidence,
    },
    {
      id: `${baseId}:work`,
      label: '필요한 작업 수행',
      kind: 'ai_step',
      status: pendingStatus,
      owner: latestExecution.owner === 'system' ? 'system' : 'ai',
      automationLevel: latestExecution.automationLevel,
      summary: '실제 단계는 사용자 입력, 도구 결과, 파일 변경, 오류에 따라 runtime event로 갱신됩니다.',
    },
    {
      id: `${baseId}:handoff`,
      label: '결과와 다음 행동 정리',
      kind: 'artifact',
      status: pendingStatus,
      owner: latestExecution.owner === 'system' ? 'system' : 'ai',
      automationLevel: latestExecution.automationLevel,
      summary: '완료 시 결론, 산출물, 검증 결과 또는 남은 사용자 선택지를 연결합니다.',
    },
  ];
}

export async function getSessionProcessMap(args: {
  sessionId: string;
  projectId?: string | null;
  title?: string | null;
  limit?: number;
}): Promise<ProcessMap> {
  const processMapWrite = await getLatestProcessMapWrite(args);
  if (processMapWrite) return processMapWrite;

  const rows = await query<any>(`
    SELECT * FROM process_events
    WHERE session_id = $1
    ORDER BY occurred_at ASC
    LIMIT $2
  `, [args.sessionId, args.limit || 100]);
  const mappedEvents = rows.map(mapEventRow);
  const commandNodes = buildCommandInvocationNodes(mappedEvents);
  const skillNodes = buildSkillInvocationNodes(mappedEvents);
  const executionNodes = [...commandNodes, ...skillNodes].sort((a, b) => firstEventTimeForNode(a, mappedEvents) - firstEventTimeForNode(b, mappedEvents));
  const latestExecution = executionNodes[executionNodes.length - 1] || null;
  const runtimeDraftNodes = buildRuntimeDraftNodes(latestExecution);
  const hasFailed = executionNodes.some((node) => node.status === 'failed');
  const running = executionNodes.some((node) => node.status === 'running');
  const status: ProcessMap['status'] = hasFailed ? 'failed' : running ? 'running' : 'completed';
  const nodes: ProcessNode[] = [
    {
      id: 'intent',
      label: args.title || 'Chat session',
      kind: 'user_intent',
      status: 'completed',
      owner: 'human',
      automationLevel: 'assisted',
      summary: latestExecution ? '현재 command 실행을 기준으로 runtime이 생성한 진행 지도입니다.' : '이 채팅 세션에서 감지된 실행 흐름입니다.',
      evidence: { sessionIds: [args.sessionId] },
    },
    ...executionNodes,
    ...runtimeDraftNodes,
    ...(executionNodes.length === 0 ? [{
      id: 'no-events',
      label: '아직 실행 흔적 없음',
      kind: 'ai_step',
      status: 'pending',
      owner: 'ai',
      automationLevel: 'assisted',
      summary: '커맨드나 실행 이벤트가 생기면 이곳에 표시됩니다.',
    } satisfies ProcessNode] : []),
  ];
  return {
    id: `session:${args.sessionId}`,
    title: `${args.title || 'Chat'} Run Canvas`,
    projectId: args.projectId ?? null,
    source: 'chat',
    abstractionLevel: 'run',
    status,
    sourceRefs: { sessionIds: [args.sessionId], latestExecutionNodeId: latestExecution?.id, activityNodeCount: executionNodes.length },
    nodes,
    edges: buildLinearEdges(nodes, hasFailed),
    createdAt: mappedEvents[0]?.occurredAt || new Date().toISOString(),
    updatedAt: mappedEvents[mappedEvents.length - 1]?.occurredAt || new Date().toISOString(),
  };
}

/**
 * Build a user-facing run-level process map from an automation run and related process events.
 * This is intentionally a coarse projection, not a TodoWrite/checklist graph.
 */
export async function getAutomationRunProcessMap(
  automation: Automation,
  run: AutomationRun,
  viewer?: { userId: number; role: string },
): Promise<ProcessMap> {
  const events = await query<any>(`
    SELECT * FROM process_events
    WHERE run_id = $1 AND automation_id = $2
    ORDER BY occurred_at ASC
    LIMIT 100
  `, [run.id, automation.id]);
  // Process event labels/payloads are unstructured. An event without a Session
  // cannot prove who may read its contents; only retain verified Session events
  // in the user-facing HTTP projection. Do not evaluate a payload before ACL.
  const mayReadSession = async (id: string) => {
    if (!viewer) return true;
    try { return (await canAccessSession(id, viewer.userId, viewer.role)).allowed; }
    catch { return false; }
  };
  const mappedEvents: ProcessEvent[] = [];
  for (const event of events) {
    if (!viewer || (event.session_id && await mayReadSession(event.session_id))) mappedEvents.push(mapEventRow(event));
  }
  const createdBySessionId = automation.createdBySessionId && await mayReadSession(automation.createdBySessionId)
    ? automation.createdBySessionId : null;
  const automationSessionId = automation.sessionId && await mayReadSession(automation.sessionId)
    ? automation.sessionId : null;
  const unverifiedSpawn = isUnverifiedAiSpawn(run, automation);
  const status = unverifiedSpawn ? 'blocked' : inferRunStatus(run);
  const owner = inferOwner(automation);
  const level = inferAutomationLevel(automation);
  const failed = status === 'failed';

  const workflowStepNodes = parseWorkflowStepMarkers(run);
  const commandNodes = buildCommandInvocationNodes(mappedEvents);
  const skillNodes = buildSkillInvocationNodes(mappedEvents);
  const nodes: ProcessNode[] = [
    {
      id: 'intent',
      label: automation.name,
      kind: 'user_intent',
      status: 'completed',
      owner: 'human',
      automationLevel: automation.triggerType === 'manual' ? 'assisted' : 'semi_auto',
      summary: viewer ? undefined : automation.description || automation.prompt || undefined,
      evidence: { sessionIds: createdBySessionId ? [createdBySessionId] : undefined },
    },
    {
      id: 'trigger',
      label: automation.triggerType === 'manual' ? '수동 실행' : automation.triggerType === 'once' ? '예약 실행' : '반복 스케줄 실행',
      kind: 'decision',
      status: 'completed',
      owner: 'system',
      automationLevel: level,
      summary: `trigger=${run.trigger || automation.triggerType}`,
      evidence: { eventIds: mappedEvents.filter((e) => e.eventType === 'step_started').map((e) => e.id).slice(0, 5) },
    },
    ...commandNodes,
    ...skillNodes,
    ...workflowStepNodes,
    ...(workflowStepNodes.length === 0 ? [{
      id: 'execute',
      label: automation.jobType === 'ai_prompt' ? 'AI 작업 실행' : automation.jobType === 'webhook' ? '외부 호출 실행' : automation.jobType === 'monitor' ? '상태 점검 실행' : '코드/스크립트 실행',
      kind: automation.jobType === 'ai_prompt' ? 'ai_step' : automation.jobType === 'webhook' ? 'tool_step' : 'tool_step',
      status: unverifiedSpawn ? 'blocked' : failed ? 'failed' : status === 'completed' ? 'completed' : 'running',
      owner,
      automationLevel: level,
      summary: unverifiedSpawn ? 'AI 작업 생성은 확인됐지만 실행 완료·외부 발송은 확인되지 않았습니다.' : run.summaryText || run.error || undefined,
      evidence: runEvidence(run, mappedEvents, automation),
    } satisfies ProcessNode] : []),
    {
      id: failed ? 'blocker' : 'artifact',
      label: failed ? '실패 원인 확인 필요' : '실행 결과 기록',
      kind: failed ? 'blocker' : 'artifact',
      status: unverifiedSpawn || (status !== 'completed' && !failed) ? 'pending' : failed ? 'blocked' : 'completed',
      owner: failed ? 'human' : 'system',
      automationLevel: failed ? 'manual' : level,
      summary: failed ? (run.error || '실행 실패') : unverifiedSpawn ? 'AI 작업 시작은 확인됐지만 최종 결과는 아직 확인되지 않았습니다.' : status !== 'completed' ? '실행 중입니다.' : (run.resultId ? '결과 세션/로그가 연결되었습니다.' : '실행 이력이 저장되었습니다.'),
      evidence: runEvidence(run, mappedEvents, automation),
    },
  ];

  const edges = buildLinearEdges(nodes, failed);

  return {
    id: `automation-run:${run.id}`,
    title: `${automation.name} 실행 흐름`,
    projectId: automation.projectId,
    source: 'schedule',
    abstractionLevel: 'run',
    status,
    sourceRefs: {
      automationIds: [automation.id],
      runIds: [run.id],
      sessionIds: [createdBySessionId, automationSessionId, automationResultSessionId(run, automation) && await mayReadSession(automationResultSessionId(run, automation)!) ? automationResultSessionId(run, automation) : null].filter(Boolean),
    },
    nodes,
    edges,
    createdAt: run.startedAt || run.ranAt,
    updatedAt: run.finishedAt || run.ranAt,
  };
}
