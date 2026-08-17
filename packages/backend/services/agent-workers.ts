// Owns Agent Control Plane MVP persistence and worker orchestration helpers.
// Public API: createPersistentWorker, sendWorker, listWorkers, getWorkerStatus,
// recoverRunningAgentRunsOnStartup, startAgentRunSettlementRecovery.
// See: workspace/decisions/2026-06-13-agent-control-plane-unification.md

import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../db/pg-repo.js";
import { extractTextFromContent } from "../utils/text.js";
import { getAllRunningSessionIds } from "../engines/index.js";
import { getSession } from "./session/session-manager.js";
import { getSessionProjectAgentRuntimeProfile } from "./pm/project-agent-profile.js";
import { broadcastToAll } from "../routes/ws-handler.js";
import {
  resolveAgentExecutionPolicy,
  type ModelPolicyId,
} from "./model-policy/model-policy.js";
import type { EffortLevel } from "../engines/types.js";
import {
  ensureAgentRunReportDelivered,
  getSpawnedResponse,
  type SpawnCompleteMode,
  type SendOnComplete,
} from "./session/spawn-rpc.js";
import {
  createSessionConversation,
  sendSessionConversationMessage,
} from "./session/session-conversation-service.js";

// `ephemeral`/`transient` remain legacy/back-compat; new support AIs are persistent Agent Sessions.
export type WorkerKind =
  "ephemeral" | "transient" | "persistent" | "scheduled" | "goal-owned";
export type WorkerStatus =
  "idle" | "running" | "paused" | "archived" | "failed";
export type WorkerVisibility = "background" | "sidebar" | "team" | "system";
export type RunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentWorkerRow {
  id: string;
  name: string;
  kind: WorkerKind;
  status: WorkerStatus;
  visibility: WorkerVisibility;
  owner_user_id: number;
  project_id: string | null;
  parent_session_id: string | null;
  backing_session_id: string | null;
  goal_id: string | null;
  role: string;
  instruction: string;
  capabilities: any;
  budget_policy: any;
  metadata: any;
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
}

export interface AgentRunRow {
  id: string;
  worker_id: string;
  trigger: string;
  input: string;
  status: RunStatus;
  model: string | null;
  result_summary: string | null;
  artifact_paths: any;
  error: string | null;
  metadata: any;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentStateCardRow {
  worker_id: string;
  goal: string;
  current_focus: string;
  last_action: string;
  next_action: string;
  blockers: any;
  open_questions: any;
  important_artifacts: any;
  source_run_id: string | null;
  source_message_ids: any;
  confidence: string | null;
  stale_after: string | null;
  updated_at: string;
}

export interface CreatePersistentWorkerInput {
  parentSessionId: string;
  ownerUserId: number;
  parentUsername?: string;
  parentRole: string;
  name: string;
  role: string;
  instruction: string;
  /** Identity snapshot shown on launch/report cards. */
  face?: string;
  tagline?: string;
  goal?: string;
  task?: string;
  visibility?: WorkerVisibility;
  engine?: "claude" | "pi";
  model?: string;
  modelPolicy?: ModelPolicyId;
  effort?: EffortLevel;
  onComplete?: "inject" | "wake" | "none";
  /** Stable project agent definition id, when this worker was launched from `.tower/agents`. */
  agentDefinitionId?: string;
  agentDefinitionSourcePath?: string;
}

export interface SendWorkerInput {
  callerSessionId: string;
  callerSessionName: string;
  callerUserId: number;
  callerRole: string;
  workerIdOrName: string;
  message: string;
  onComplete?: "inject" | "wake" | "none";
  /** Prefer matching by `.tower/agents` definition id over display name. */
  agentDefinitionId?: string;
}

export interface AgentWorkerIdentitySnapshot {
  name: string;
  role: string;
  face?: string;
  tagline?: string;
}

export interface AgentWorkerLaunchResult extends AgentWorkerIdentitySnapshot {
  workerId: string;
  sessionId: string;
  runId: string;
}

export interface WorkerStatusInfo {
  worker: AgentWorkerRow;
  runtimeStatus: WorkerStatus;
  stateCard: AgentStateCardRow | null;
  latestRun: AgentRunRow | null;
  lastResponse?: string;
  messageCount?: number;
  lastMessageAt?: string | null;
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function normalizeOnComplete(
  mode?: "inject" | "wake" | "none",
): SpawnCompleteMode {
  if (mode === "none") return "none";
  if (mode === "inject") return "inject-only";
  return "inject-and-wake";
}

/** Resolve a worker's immutable identity, preferring an explicit Helper face over its parent Primary Agent. */
export function buildWorkerIdentitySnapshot(
  input: Pick<
    CreatePersistentWorkerInput,
    "name" | "role" | "face" | "tagline"
  >,
  parentProfile?: { face?: string | null } | null,
): AgentWorkerIdentitySnapshot {
  return {
    name: input.name,
    role: input.role,
    face: input.face || parentProfile?.face || undefined,
    tagline: input.tagline,
  };
}

function textSummary(text: string, max = 900): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 1) + "…";
}

function parseJsonArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function extractReportSection(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`${escaped}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`),
  );
  return match?.[1]?.trim() || undefined;
}

function extractArtifactPathsFromText(text: string): string[] {
  const detailArtifacts =
    extractReportSection(text, "DETAIL_ARTIFACTS") || text;
  const pathRegex =
    /(?:~\/workspace|\/home\/enterpriseai\/workspace|\/workspace)\/[^\s,;)]+/g;
  const found = detailArtifacts.match(pathRegex) || [];
  return Array.from(new Set(found.map((p) => p.trim()).filter(Boolean)));
}

function formatArtifactPath(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const maybe = value as { path?: unknown; file?: unknown; href?: unknown };
    const path = maybe.path || maybe.file || maybe.href;
    return typeof path === "string" ? path : null;
  }
  return null;
}

async function recordAgentEvent(input: {
  kind: string;
  workerId?: string | null;
  runId?: string | null;
  ownerUserId?: number | null;
  projectId?: string | null;
  parentSessionId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await execute(
    `INSERT INTO agent_events
       (id, kind, worker_id, run_id, owner_user_id, project_id, parent_session_id, session_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuidv4(),
      input.kind,
      input.workerId ?? null,
      input.runId ?? null,
      input.ownerUserId ?? null,
      input.projectId ?? null,
      input.parentSessionId ?? null,
      input.sessionId ?? null,
      jsonParam(input.metadata ?? {}),
    ],
  );
}

async function createRun(input: {
  workerId: string;
  trigger: string;
  message: string;
  status?: RunStatus;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const runId = uuidv4();
  await execute(
    `INSERT INTO agent_runs (id, worker_id, trigger, input, status, metadata, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      runId,
      input.workerId,
      input.trigger,
      input.message,
      input.status || "running",
      jsonParam(input.metadata ?? {}),
    ],
  );
  return runId;
}

async function broadcastAgentSessionMeta(sessionId: string): Promise<void> {
  try {
    const session = await getSession(sessionId);
    if (!session) return;
    broadcastToAll({
      type: "session_meta_update",
      sessionId,
      updates: { label: session.label, agent: session.agent },
    });
  } catch (err: any) {
    console.warn(
      `[agent-workers] session meta broadcast failed for ${sessionId.slice(0, 8)}:`,
      err?.message || err,
    );
  }
}

async function completeRun(
  runId: string,
  resultSummary: string,
  status: RunStatus = "completed",
  artifactPaths: string[] = [],
): Promise<void> {
  await execute(
    `UPDATE agent_runs
        SET status = $2,
            result_summary = $3,
            artifact_paths = CASE
              WHEN $4::jsonb = '[]'::jsonb THEN artifact_paths
              ELSE $4::jsonb
            END,
            ended_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [runId, status, resultSummary, jsonParam(artifactPaths)],
  );
}

async function markRunFailed(runId: string, error: string): Promise<void> {
  await execute(
    `UPDATE agent_runs
        SET status = 'failed', error = $2, ended_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [runId, error],
  );
}

async function setWorkerStatus(
  workerId: string,
  status: WorkerStatus,
): Promise<void> {
  await execute(
    `UPDATE agent_workers
        SET status = $2, updated_at = NOW(), last_heartbeat_at = NOW()
      WHERE id = $1`,
    [workerId, status],
  );
}

async function upsertStateCard(input: {
  workerId: string;
  goal: string;
  currentFocus: string;
  lastAction: string;
  nextAction: string;
  sourceRunId?: string | null;
  sourceMessageIds?: string[];
  confidence?: "low" | "medium" | "high";
}): Promise<void> {
  await execute(
    `INSERT INTO agent_state_cards
       (worker_id, goal, current_focus, last_action, next_action,
        blockers, open_questions, important_artifacts, source_run_id,
        source_message_ids, confidence, stale_after, updated_at)
     VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $6, $7, $8, NOW() + INTERVAL '7 days', NOW())
     ON CONFLICT(worker_id) DO UPDATE SET
       goal = EXCLUDED.goal,
       current_focus = EXCLUDED.current_focus,
       last_action = EXCLUDED.last_action,
       next_action = EXCLUDED.next_action,
       source_run_id = EXCLUDED.source_run_id,
       source_message_ids = EXCLUDED.source_message_ids,
       confidence = EXCLUDED.confidence,
       stale_after = EXCLUDED.stale_after,
       updated_at = NOW()`,
    [
      input.workerId,
      input.goal,
      input.currentFocus,
      input.lastAction,
      input.nextAction,
      input.sourceRunId ?? null,
      jsonParam(input.sourceMessageIds ?? []),
      input.confidence ?? "medium",
    ],
  );
}

async function getLastAssistantMessage(
  sessionId: string,
  opts: { requireText?: boolean } = {},
): Promise<{ id: string; text: string; createdAt: string } | null> {
  const rows = await query<{ id: string; content: string; created_at: string }>(
    `SELECT id, content, created_at
       FROM messages
      WHERE session_id = $1 AND role = 'assistant'
      ORDER BY created_at DESC
      LIMIT 20`,
    [sessionId],
  );
  for (const row of rows) {
    const text = extractTextFromContent(row.content).trim();
    if (opts.requireText && !text) continue;
    return { id: row.id, text, createdAt: row.created_at };
  }
  return null;
}

async function refreshWorkerFromBackingSession(
  worker: AgentWorkerRow,
  runId?: string,
): Promise<void> {
  if (!worker.backing_session_id) return;
  // A backing Agent Session often emits assistant tool_use rows before its final
  // text answer. After backend restarts those tool_use-only rows can be the
  // latest assistant row for a short window; do not treat them as a completed
  // subagent response or the run gets stuck as "(no assistant response yet)".
  const last = await getLastAssistantMessage(worker.backing_session_id, {
    requireText: true,
  });
  if (!last) return;

  let latestRun: AgentRunRow | null = null;
  if (runId) {
    latestRun =
      (await queryOne<AgentRunRow>("SELECT * FROM agent_runs WHERE id = $1", [
        runId,
      ])) || null;
    if (
      latestRun &&
      new Date(last.createdAt).getTime() <
        new Date(latestRun.created_at).getTime()
    ) {
      // The backing session's latest assistant message predates this run. Do not
      // mark the run completed with a stale response.
      return;
    }
  }

  const resultSummary = textSummary(last.text);
  const artifactPaths = extractArtifactPathsFromText(last.text);
  const latestForWorker = await queryOne<{ id: string }>(
    `SELECT id FROM agent_runs WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [worker.id],
  );
  const shouldUpdateStateCard = !runId || latestForWorker?.id === runId;
  if (shouldUpdateStateCard) {
    const currentFocus = worker.role || worker.name;
    const nextAction =
      "다음 호출을 기다리거나, 현재 목표 기준으로 이어서 진행한다.";
    await upsertStateCard({
      workerId: worker.id,
      goal: worker.metadata?.goal || worker.role || worker.name,
      currentFocus,
      lastAction: resultSummary || "아직 요약할 응답이 없다.",
      nextAction,
      sourceRunId: runId ?? null,
      sourceMessageIds: [last.id],
      confidence: "medium",
    });
  }
  if (
    runId &&
    (!latestRun ||
      latestRun.status === "running" ||
      latestRun.status === "queued" ||
      latestRun.result_summary === "(no assistant response yet)")
  ) {
    await completeRun(runId, resultSummary, "completed", artifactPaths);
    if (worker.parent_session_id) {
      await ensureAgentRunReportDelivered({
        parentSessionId: worker.parent_session_id,
        parentUserId: worker.owner_user_id,
        fromName: worker.metadata?.identity?.name || worker.name,
        text: last.text,
        onComplete: (latestRun?.metadata?.onComplete || "wake") as SendOnComplete,
        agentReport: {
          workerId: worker.id,
          runId,
          backingSessionId: worker.backing_session_id,
          workerName: worker.metadata?.identity?.name || worker.name,
          workerRole: worker.metadata?.identity?.role || worker.role,
          workerFace: worker.metadata?.identity?.face || undefined,
          workerTagline: worker.metadata?.identity?.tagline || undefined,
          retrievalHint:
            "Open the backing session or persistent_agent_status; use detailArtifactPaths when present.",
        },
      }).catch((err) => {
        console.warn(
          `[agent-workers] parent report backfill failed for ${runId.slice(0, 8)}:`,
          err?.message || err,
        );
      });
    }
  }
}

function scheduleRunSettlement(
  workerId: string,
  runId: string,
  attempt = 0,
): void {
  const delayMs = attempt === 0 ? 1000 : Math.min(1000 + attempt * 500, 3000);
  const timer = setTimeout(() => {
    settleRunFromBackingSession(workerId, runId, attempt).catch((err) => {
      console.warn(
        `[agent-workers] run settlement failed for ${runId.slice(0, 8)}:`,
        err,
      );
    });
  }, delayMs);
  (timer as any).unref?.();
}

async function settleRunFromBackingSession(
  workerId: string,
  runId: string,
  attempt: number,
): Promise<void> {
  const worker = await queryOne<AgentWorkerRow>(
    "SELECT * FROM agent_workers WHERE id = $1",
    [workerId],
  );
  if (!worker || !worker.backing_session_id) return;

  const isBackingRunning = getAllRunningSessionIds().includes(
    worker.backing_session_id,
  );
  if (isBackingRunning) {
    if (attempt < 60) scheduleRunSettlement(workerId, runId, attempt + 1);
    return;
  }

  await refreshWorkerFromBackingSession(worker, runId);

  const run = await queryOne<AgentRunRow>(
    "SELECT * FROM agent_runs WHERE id = $1",
    [runId],
  );
  if (run && (run.status === "running" || run.status === "queued")) {
    // Engine has gone idle but the final assistant row may still be racing into
    // messages. Retry briefly instead of leaving the run stuck forever.
    if (attempt < 60) scheduleRunSettlement(workerId, runId, attempt + 1);
    return;
  }

  const stillRunning =
    worker.backing_session_id &&
    getAllRunningSessionIds().includes(worker.backing_session_id);
  if (
    !stillRunning &&
    worker.status !== "paused" &&
    worker.status !== "archived"
  ) {
    await setWorkerStatus(worker.id, "idle");
  }
}

/**
 * Re-arm settlement for agent runs that were marked running/queued before a
 * backend restart. Backing Agent Sessions are recovered by session auto-resume;
 * this sweep keeps Agent Control Plane run rows/state cards from staying stuck.
 */
export async function recoverRunningAgentRunsOnStartup(): Promise<number> {
  const rows = await query<{ worker_id: string; run_id: string }>(
    `SELECT w.id AS worker_id, r.id AS run_id
       FROM agent_runs r
       JOIN agent_workers w ON w.id = r.worker_id
      WHERE r.status IN ('running', 'queued')
        AND w.backing_session_id IS NOT NULL
        AND w.status NOT IN ('paused', 'archived')
      ORDER BY r.started_at ASC
      LIMIT 200`,
  );

  for (const row of rows) {
    scheduleRunSettlement(row.worker_id, row.run_id);
  }
  if (rows.length > 0) {
    console.log(
      `[agent-workers] re-armed settlement for ${rows.length} running/queued run(s)`,
    );
  }
  return rows.length;
}

let settlementRecoveryTimer: NodeJS.Timeout | null = null;

export function startAgentRunSettlementRecovery(): void {
  if (settlementRecoveryTimer) return;
  settlementRecoveryTimer = setInterval(() => {
    recoverRunningAgentRunsOnStartup().catch((err) => {
      console.warn(
        "[agent-workers] periodic run settlement recovery failed:",
        err?.message || err,
      );
    });
  }, 60_000);
  settlementRecoveryTimer.unref?.();
}

export function stopAgentRunSettlementRecovery(): void {
  if (!settlementRecoveryTimer) return;
  clearInterval(settlementRecoveryTimer);
  settlementRecoveryTimer = null;
}

export async function resolveWorkerForCaller(
  ownerUserId: number,
  parentSessionId: string,
  idOrName: string,
): Promise<AgentWorkerRow> {
  const exact = await queryOne<AgentWorkerRow>(
    `SELECT * FROM agent_workers
      WHERE owner_user_id = $1
        AND (id = $2 OR backing_session_id = $2)
      LIMIT 1`,
    [ownerUserId, idOrName],
  );
  if (exact) return exact;

  const rows = await query<AgentWorkerRow>(
    `SELECT * FROM agent_workers
      WHERE owner_user_id = $1
        AND (parent_session_id = $2 OR parent_session_id IS NULL)
        AND (name ILIKE $3 OR id LIKE $4 OR metadata->>'definitionId' = $5)
      ORDER BY updated_at DESC
      LIMIT 5`,
    [ownerUserId, parentSessionId, idOrName, idOrName + "%", idOrName],
  );
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) {
    throw Object.assign(
      new Error(
        `WORKER_AMBIGUOUS: ${rows.map((r) => `${r.name}:${r.id.slice(0, 8)}`).join(", ")}`,
      ),
      {
        code: "WORKER_AMBIGUOUS",
        status: 400,
      },
    );
  }
  throw Object.assign(new Error("WORKER_NOT_FOUND"), {
    code: "WORKER_NOT_FOUND",
    status: 404,
  });
}

export async function createPersistentWorker(
  input: CreatePersistentWorkerInput,
): Promise<AgentWorkerLaunchResult> {
  const parent = await getSession(input.parentSessionId);
  if (!parent) {
    throw Object.assign(new Error("PARENT_NOT_FOUND"), {
      code: "PARENT_NOT_FOUND",
      status: 404,
    });
  }

  const parentProfile = parent.projectId
    ? await getSessionProjectAgentRuntimeProfile(
        input.parentSessionId,
        parent.projectId,
      ).catch(() => null)
    : null;
  const identity = buildWorkerIdentitySnapshot(input, parentProfile);
  const workerId = uuidv4();
  const goal = input.goal || input.role || input.name;
  const shouldResolvePiPolicy =
    input.engine === "pi" ||
    !!input.modelPolicy ||
    !!input.effort ||
    !!input.model?.includes("/");
  const executionPolicy = shouldResolvePiPolicy
    ? resolveAgentExecutionPolicy({
        model: input.model,
        modelPolicy: input.modelPolicy,
        effort: input.effort,
      })
    : null;
  const initialTask =
    input.task?.trim() ||
    "위 역할과 지시를 이해하고, 지금부터 어떤 방식으로 일을 이어갈지 짧게 상태 보고를 작성하라.";
  const bootstrapPrompt = [
    `너는 Tower의 subagent "${input.name}"이다.`,
    "",
    `역할: ${input.role}`,
    "",
    `지시: ${input.instruction}`,
    "",
    "운영 규칙:",
    "- 이 세션은 subagent의 backing Agent Session이다. 맥락을 유지하고 후속 호출에서 이어서 일한다.",
    "- 부모 세션의 목표·제약·성공 기준을 먼저 재진술하고, 모호하면 가장 안전한 가정을 명시한다.",
    "- 깊은 분석, 툴콜 흔적, 중간 생각, 긴 표는 이 backing session 또는 workspace 산출물에 남긴다. 부모에게는 핵심 보고만 간결히 전달된다.",
    "- 최종 답변 끝에는 필요할 때만 부모 전달용 `PARENT_NEXT:` 한 줄을 둘 수 있다. 부모가 즉시 해야 할 다음 판단/질문/중단 신호만 적는다.",
    "- 긴 원문/표/검증 로그를 파일로 남겼다면, 부모가 나중에 찾아볼 수 있도록 선택적으로 `DETAIL_ARTIFACTS:` 아래에 절대경로와 한 줄 설명을 적는다.",
    "- 부모가 필요할 때만 읽으면 좋은 구간이 분명할 때만 `READ_IF_NEEDED:` 아래에 섹션명/라인 범위/읽는 이유를 적는다. 억지로 채우지 않는다.",
    "- 부모용 보고는 결론, 근거 3~5개, 산출물 절대경로, 리스크/불확실성을 중심으로 900~1500자 내외를 목표로 한다. DETAIL_ARTIFACTS, READ_IF_NEEDED, PARENT_NEXT는 도움이 될 때만 덧붙이는 힌트이며, 본문 요약 안에서 필드명을 반복 설명하지 말고 필요하면 별도 섹션에만 둔다.",
    "- 상세 원문이 필요한 경우 부모/사용자가 이 backing session 또는 산출물 파일을 열어볼 수 있게 파일 경로와 읽을 위치를 남긴다.",
    "- destructive action, 배포, 외부 메시지 전송, 비용 큰 반복 작업은 사용자/부모 확인 없이 하지 않는다.",
    "- 필요한 경우 산출물은 workspace 안에 만들고 절대경로를 남긴다.",
    "",
    "작업:",
    initialTask,
  ].join("\n");

  await execute(
    `INSERT INTO agent_workers
       (id, name, kind, status, visibility, owner_user_id, project_id,
        parent_session_id, role, instruction, metadata)
     VALUES ($1, $2, 'persistent', 'running', $3, $4, $5, $6, $7, $8, $9)`,
    [
      workerId,
      input.name,
      input.visibility || "background",
      input.ownerUserId,
      parent.projectId || null,
      input.parentSessionId,
      input.role,
      input.instruction,
      jsonParam({
        goal,
        task: input.task || null,
        identity: {
          ...identity,
          face: identity.face || null,
          tagline: identity.tagline || null,
        },
        definitionId: input.agentDefinitionId || null,
        definitionSourcePath: input.agentDefinitionSourcePath || null,
        executionPolicy,
      }),
    ],
  );

  const runId = await createRun({
    workerId,
    trigger: "user",
    message: bootstrapPrompt,
    status: "queued",
    metadata: {
      phase: "create",
      onComplete: input.onComplete || "wake",
      definitionId: input.agentDefinitionId || null,
      definitionSourcePath: input.agentDefinitionSourcePath || null,
      executionPolicy,
    },
  });

  let sessionId = "";
  try {
    const spawned = await createSessionConversation({
      sourceSessionId: input.parentSessionId,
      sourceUserId: input.ownerUserId,
      sourceUsername: input.parentUsername,
      sourceRole: input.parentRole,
      prompt: bootstrapPrompt,
      name: input.name,
      engine: input.engine,
      model: executionPolicy?.effectiveModel || input.model,
      effort: executionPolicy?.effectiveEffort || input.effort,
      modelPolicyId: executionPolicy?.id,
      modelPolicyRevision: executionPolicy?.revision,
      requestedEffort: executionPolicy?.requestedEffort,
      effortDowngraded: executionPolicy?.effortDowngraded,
      contextSummary: `Subagent bootstrap. Role: ${input.role}`,
      onComplete: {
        mode: normalizeOnComplete(input.onComplete),
        agentReport: {
          workerId,
          runId,
          workerName: identity.name,
          workerRole: identity.role,
          workerFace: identity.face,
          workerTagline: identity.tagline,
          retrievalHint:
            "Open the backing session or persistent_agent_status; use detailArtifactPaths when present.",
        },
      },
    });
    sessionId = spawned.sessionId;

    // Agent Session unification: a worker backing session is a first-class
    // agent session, not merely a hidden L3 spawn child. Keep the parent link
    // for provenance, but label it so /api/sessions can surface it in the
    // sidebar and search can later filter Chats vs Agents.
    await execute(
      `UPDATE sessions
          SET label = 'agent'
        WHERE id = $1`,
      [sessionId],
    );

    await execute(
      `UPDATE agent_workers
          SET backing_session_id = $2,
              metadata = metadata || $3::jsonb,
              updated_at = NOW(),
              last_heartbeat_at = NOW()
        WHERE id = $1`,
      [workerId, sessionId, jsonParam({ spawnId: spawned.spawnId })],
    );
    await broadcastAgentSessionMeta(sessionId);

    await execute(
      `UPDATE agent_runs
          SET status = 'running', metadata = metadata || $3::jsonb, updated_at = NOW()
        WHERE id = $2 AND worker_id = $1`,
      [workerId, runId, jsonParam({ backingSessionId: sessionId })],
    );
    await upsertStateCard({
      workerId,
      goal,
      currentFocus: input.role,
      lastAction: "Subagent 생성 및 초기 작업 실행 시작.",
      nextAction: "초기 작업 완료 후 필요하면 같은 subagent로 이어서 호출한다.",
      sourceRunId: runId,
      confidence: "medium",
    });
    await recordAgentEvent({
      kind: "worker_created",
      workerId,
      runId,
      ownerUserId: input.ownerUserId,
      projectId: parent.projectId || null,
      parentSessionId: input.parentSessionId,
      sessionId,
      metadata: {
        name: input.name,
        role: input.role,
        visibility: input.visibility || "background",
        task: input.task || null,
        definitionId: input.agentDefinitionId || null,
        definitionSourcePath: input.agentDefinitionSourcePath || null,
      },
    });
    scheduleRunSettlement(workerId, runId);
    return {
      workerId,
      sessionId,
      runId,
      ...identity,
    };
  } catch (err: any) {
    await markRunFailed(runId, err?.message || String(err)).catch(() => {});
    await setWorkerStatus(workerId, "failed").catch(() => {});
    throw err;
  }
}

export async function sendWorker(
  input: SendWorkerInput,
): Promise<AgentWorkerLaunchResult> {
  const worker = await resolveWorkerForCaller(
    input.callerUserId,
    input.callerSessionId,
    input.agentDefinitionId || input.workerIdOrName,
  );
  if (!worker.backing_session_id) {
    throw Object.assign(new Error("WORKER_HAS_NO_BACKING_SESSION"), {
      code: "WORKER_HAS_NO_BACKING_SESSION",
      status: 400,
    });
  }
  if (worker.status === "paused" || worker.status === "archived") {
    throw Object.assign(new Error(`WORKER_${worker.status.toUpperCase()}`), {
      code: `WORKER_${worker.status.toUpperCase()}`,
      status: 409,
    });
  }

  const runId = await createRun({
    workerId: worker.id,
    trigger: "user",
    message: input.message,
    status: "running",
    metadata: {
      backingSessionId: worker.backing_session_id,
      onComplete: input.onComplete || "wake",
      definitionId:
        input.agentDefinitionId || worker.metadata?.definitionId || null,
    },
  });
  await setWorkerStatus(worker.id, "running");
  await upsertStateCard({
    workerId: worker.id,
    goal: worker.metadata?.goal || worker.role || worker.name,
    currentFocus: worker.role || worker.name,
    lastAction: `후속 호출 수신: ${textSummary(input.message, 240)}`,
    nextAction: "backing session에서 후속 작업을 처리하는 중.",
    sourceRunId: runId,
    confidence: "medium",
  });

  try {
    const executionPolicy = worker.metadata?.executionPolicy || null;
    await sendSessionConversationMessage({
      sourceSessionId: input.callerSessionId,
      sourceSessionName: input.callerSessionName,
      sourceUserId: input.callerUserId,
      sourceRole: input.callerRole,
      targetSessionId: worker.backing_session_id,
      message: input.message,
      onComplete: input.onComplete || "wake",
      effort: executionPolicy?.effectiveEffort,
      modelPolicyId: executionPolicy?.id,
      modelPolicyRevision: executionPolicy?.revision,
      requestedEffort: executionPolicy?.requestedEffort,
      effortDowngraded: executionPolicy?.effortDowngraded,
      agentReport: {
        workerId: worker.id,
        runId,
        backingSessionId: worker.backing_session_id,
        workerName: worker.metadata?.identity?.name || worker.name,
        workerRole: worker.metadata?.identity?.role || worker.role,
        workerFace: worker.metadata?.identity?.face || undefined,
        workerTagline: worker.metadata?.identity?.tagline || undefined,
        retrievalHint:
          "Open the backing session or persistent_agent_status; use detailArtifactPaths when present.",
      },
    });
    await recordAgentEvent({
      kind: "worker_messaged",
      workerId: worker.id,
      runId,
      ownerUserId: input.callerUserId,
      projectId: worker.project_id,
      parentSessionId: input.callerSessionId,
      sessionId: worker.backing_session_id,
      metadata: {
        onComplete: input.onComplete || "wake",
        definitionId:
          input.agentDefinitionId || worker.metadata?.definitionId || null,
      },
    });
    scheduleRunSettlement(worker.id, runId);
    const identity = worker.metadata?.identity || {};
    return {
      workerId: worker.id,
      sessionId: worker.backing_session_id,
      runId,
      name: identity.name || worker.name,
      role: identity.role || worker.role,
      face: identity.face || undefined,
      tagline: identity.tagline || undefined,
    };
  } catch (err: any) {
    await markRunFailed(runId, err?.message || String(err)).catch(() => {});
    await setWorkerStatus(worker.id, "failed").catch(() => {});
    throw err;
  }
}

export async function refreshWorkerStatus(workerId: string): Promise<void> {
  const worker = await queryOne<AgentWorkerRow>(
    "SELECT * FROM agent_workers WHERE id = $1",
    [workerId],
  );
  if (!worker) return;
  const runningIds = new Set(getAllRunningSessionIds());
  const runtimeStatus: WorkerStatus =
    worker.backing_session_id && runningIds.has(worker.backing_session_id)
      ? "running"
      : worker.status === "archived" || worker.status === "paused"
        ? worker.status
        : "idle";
  await setWorkerStatus(worker.id, runtimeStatus);
  const latestRun = await queryOne<AgentRunRow>(
    `SELECT * FROM agent_runs WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [worker.id],
  );
  if (worker.backing_session_id) {
    await refreshWorkerFromBackingSession(worker, latestRun?.id);
  }
}

export async function getWorkerStatus(
  ownerUserId: number,
  parentSessionId: string,
  idOrName: string,
): Promise<WorkerStatusInfo> {
  const worker = await resolveWorkerForCaller(
    ownerUserId,
    parentSessionId,
    idOrName,
  );
  await refreshWorkerStatus(worker.id).catch(() => {});
  const fresh =
    (await queryOne<AgentWorkerRow>(
      "SELECT * FROM agent_workers WHERE id = $1",
      [worker.id],
    )) || worker;
  const runningIds = new Set(getAllRunningSessionIds());
  const runtimeStatus: WorkerStatus =
    fresh.backing_session_id && runningIds.has(fresh.backing_session_id)
      ? "running"
      : fresh.status;
  const stateCard =
    (await queryOne<AgentStateCardRow>(
      "SELECT * FROM agent_state_cards WHERE worker_id = $1",
      [worker.id],
    )) || null;
  const latestRun =
    (await queryOne<AgentRunRow>(
      `SELECT * FROM agent_runs WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [worker.id],
    )) || null;

  let lastResponse = "";
  let messageCount = 0;
  let lastMessageAt: string | null = null;
  if (fresh.backing_session_id) {
    try {
      const info = await getSpawnedResponse(
        fresh.parent_session_id || parentSessionId,
        fresh.backing_session_id,
      );
      lastResponse = info.lastResponse;
      messageCount = info.messageCount;
      lastMessageAt = info.lastMessageAt;
    } catch {
      const last = await getLastAssistantMessage(fresh.backing_session_id);
      lastResponse = last?.text || "";
      lastMessageAt = last?.createdAt || null;
    }
  }

  return {
    worker: fresh,
    runtimeStatus,
    stateCard,
    latestRun,
    lastResponse,
    messageCount,
    lastMessageAt,
  };
}

export async function listWorkers(input: {
  ownerUserId: number;
  parentSessionId?: string;
  projectId?: string | null;
  includeArchived?: boolean;
  limit?: number;
}): Promise<WorkerStatusInfo[]> {
  const limit = Math.min(input.limit || 20, 100);
  const clauses = ["owner_user_id = $1"];
  const params: any[] = [input.ownerUserId];
  let idx = 2;
  if (input.parentSessionId) {
    clauses.push(`(parent_session_id = $${idx} OR parent_session_id IS NULL)`);
    params.push(input.parentSessionId);
    idx++;
  }
  if (input.projectId !== undefined) {
    clauses.push(
      `project_id ${input.projectId === null ? "IS NULL" : `= $${idx}`}`,
    );
    if (input.projectId !== null) {
      params.push(input.projectId);
      idx++;
    }
  }
  if (!input.includeArchived) clauses.push(`status <> 'archived'`);
  params.push(limit);

  const rows = await query<AgentWorkerRow>(
    `SELECT * FROM agent_workers
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${idx}`,
    params,
  );

  const result: WorkerStatusInfo[] = [];
  for (const row of rows) {
    const stateCard =
      (await queryOne<AgentStateCardRow>(
        "SELECT * FROM agent_state_cards WHERE worker_id = $1",
        [row.id],
      )) || null;
    const latestRun =
      (await queryOne<AgentRunRow>(
        `SELECT * FROM agent_runs WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [row.id],
      )) || null;
    const runningIds = new Set(getAllRunningSessionIds());
    const runtimeStatus: WorkerStatus =
      row.backing_session_id && runningIds.has(row.backing_session_id)
        ? "running"
        : row.status;
    result.push({ worker: row, runtimeStatus, stateCard, latestRun });
  }
  return result;
}

export async function pauseWorker(
  ownerUserId: number,
  parentSessionId: string,
  idOrName: string,
): Promise<AgentWorkerRow> {
  const worker = await resolveWorkerForCaller(
    ownerUserId,
    parentSessionId,
    idOrName,
  );
  await setWorkerStatus(worker.id, "paused");
  await recordAgentEvent({
    kind: "worker_paused",
    workerId: worker.id,
    ownerUserId,
    projectId: worker.project_id,
    parentSessionId,
    sessionId: worker.backing_session_id,
  });
  return (
    (await queryOne<AgentWorkerRow>(
      "SELECT * FROM agent_workers WHERE id = $1",
      [worker.id],
    )) || worker
  );
}

export async function resumeWorker(
  ownerUserId: number,
  parentSessionId: string,
  idOrName: string,
): Promise<AgentWorkerRow> {
  const worker = await resolveWorkerForCaller(
    ownerUserId,
    parentSessionId,
    idOrName,
  );
  await setWorkerStatus(worker.id, "idle");
  await recordAgentEvent({
    kind: "worker_resumed",
    workerId: worker.id,
    ownerUserId,
    projectId: worker.project_id,
    parentSessionId,
    sessionId: worker.backing_session_id,
  });
  return (
    (await queryOne<AgentWorkerRow>(
      "SELECT * FROM agent_workers WHERE id = $1",
      [worker.id],
    )) || worker
  );
}

export async function archiveWorker(
  ownerUserId: number,
  parentSessionId: string,
  idOrName: string,
): Promise<AgentWorkerRow> {
  const worker = await resolveWorkerForCaller(
    ownerUserId,
    parentSessionId,
    idOrName,
  );
  await setWorkerStatus(worker.id, "archived");
  if (worker.backing_session_id) {
    await execute(
      `UPDATE sessions
          SET archived = 1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [worker.backing_session_id],
    );
  }
  await recordAgentEvent({
    kind: "worker_archived",
    workerId: worker.id,
    ownerUserId,
    projectId: worker.project_id,
    parentSessionId,
    sessionId: worker.backing_session_id,
    metadata: { sessionArchived: !!worker.backing_session_id },
  });
  return (
    (await queryOne<AgentWorkerRow>(
      "SELECT * FROM agent_workers WHERE id = $1",
      [worker.id],
    )) || worker
  );
}

export function formatWorkerStatus(info: WorkerStatusInfo): string {
  const w = info.worker;
  const card = info.stateCard;
  const latest = info.latestRun;
  const lines = [
    `${w.name} (${w.id}) [${info.runtimeStatus}]`,
    `- role: ${w.role || "(none)"}`,
    `- backing session: ${w.backing_session_id || "(none)"}`,
    `- visibility: ${w.visibility}`,
    `- latest run: ${latest ? `${latest.id.slice(0, 8)} [${latest.status}] ${latest.created_at}` : "(none)"}`,
  ];
  if (card) {
    lines.push(`- current focus: ${card.current_focus || "(none)"}`);
    lines.push(`- last action: ${card.last_action || "(none)"}`);
    lines.push(`- next action: ${card.next_action || "(none)"}`);
  }
  const artifactPaths = parseJsonArray(latest?.artifact_paths)
    .map(formatArtifactPath)
    .filter((p): p is string => !!p);
  if (artifactPaths.length > 0) {
    lines.push("", "Detail artifact paths:");
    for (const artifactPath of artifactPaths.slice(0, 10)) {
      lines.push(`- ${artifactPath}`);
    }
    if (artifactPaths.length > 10)
      lines.push(`- … ${artifactPaths.length - 10} more`);
  }
  if (info.lastResponse) {
    lines.push(
      "",
      "Last response preview:",
      textSummary(info.lastResponse, 1400),
    );
  }
  return lines.join("\n");
}
