import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BACKEND_ROOT = path.resolve(import.meta.dirname, "../..");
const PACKAGES_ROOT = path.resolve(BACKEND_ROOT, "..");
const agentWorkers = fs.readFileSync(
  path.join(BACKEND_ROOT, "services/agent-workers.ts"),
  "utf-8",
);
const agentWorkerMcp = fs.readFileSync(
  path.join(BACKEND_ROOT, "mcp/agent-worker-server.ts"),
  "utf-8",
);
const sessionManager = fs.readFileSync(
  path.join(BACKEND_ROOT, "services/session/session-manager.ts"),
  "utf-8",
);
const spawnRpc = fs.readFileSync(
  path.join(BACKEND_ROOT, "services/session/spawn-rpc.ts"),
  "utf-8",
);
const api = fs.readFileSync(path.join(BACKEND_ROOT, "routes/api.ts"), "utf-8");
const sessionCoreApi = fs.readFileSync(
  path.join(BACKEND_ROOT, "routes/session-core/session-core-router.ts"),
  "utf-8",
);
const shared = fs.readFileSync(
  path.join(PACKAGES_ROOT, "shared/index.ts"),
  "utf-8",
);
const sessionItem = fs.readFileSync(
  path.join(PACKAGES_ROOT, "frontend/src/components/sessions/SessionItem.tsx"),
  "utf-8",
);
const sidebar = fs.readFileSync(
  path.join(PACKAGES_ROOT, "frontend/src/components/layout/Sidebar.tsx"),
  "utf-8",
);
const sidebarSessionListModel = fs.readFileSync(
  path.join(
    PACKAGES_ROOT,
    "frontend/src/features/navigation-sidebar/sessions/sidebar-session-list-model.ts",
  ),
  "utf-8",
);
const sessionListFilters = fs.readFileSync(
  path.join(PACKAGES_ROOT, "frontend/src/utils/session-list-filters.ts"),
  "utf-8",
);
const frontendAgentClassification = fs.readFileSync(
  path.join(
    PACKAGES_ROOT,
    "frontend/src/features/agent-sessions/classification.ts",
  ),
  "utf-8",
);
const backendAgentClassification = fs.readFileSync(
  path.join(BACKEND_ROOT, "services/session/agent-session/classification.ts"),
  "utf-8",
);
const wsHandler = fs.readFileSync(
  path.join(BACKEND_ROOT, "routes/ws-handler.ts"),
  "utf-8",
);
const systemPrompt = fs.readFileSync(
  path.join(BACKEND_ROOT, "services/system-prompt.ts"),
  "utf-8",
);

describe("Agent Session unification contract", () => {
  it("labels worker backing sessions as first-class agent sessions and broadcasts fresh sidebar metadata", () => {
    expect(agentWorkers).toContain("SET label = 'agent'");
    expect(agentWorkers).toContain("Agent Session unification");
    expect(agentWorkers).toContain("broadcastAgentSessionMeta");
    expect(agentWorkers).toMatch(/type:\s*["']session_meta_update["']/);
    expect(agentWorkers).toContain(
      "updates: { label: session.label, agent: session.agent }",
    );
  });

  it("surfaces agent backing sessions through the normal sessions API", () => {
    expect(sessionManager).toMatch(
      /LEFT JOIN agent_workers aw ON aw\.backing_session_id = s\.id/,
    );
    expect(sessionManager).toContain("agent_worker_id");
    expect(shared).toContain("agent?: {");
    expect(sessionCoreApi).toContain(
      "getSessions(userId, role, { limit, projectId, sidebarOnly: true })",
    );
    expect(sessionManager).toContain(
      "s.parent_session_id IS NULL OR s.label IN ('spawned', 'agent', 'conversation_branch')",
    );
  });

  it("keeps agent sessions first-class while removing the permanent subagent badge", () => {
    expect(sessionItem).not.toContain("isPureAgentSession(session)");
    expect(frontendAgentClassification).toContain(
      "session.label === 'agent' || !!session.agent",
    );
    expect(frontendAgentClassification).not.toContain(
      "!session.agent?.hasHumanInput",
    );
    expect(sessionItem).not.toContain("Subagent session");
    expect(sessionItem).toMatch(/canDelete && !isChannelAi/);
    expect(api).toContain(
      "SELECT id FROM agent_workers WHERE backing_session_id = $1 LIMIT 1",
    );
    expect(api).toContain("agentWorkerArchived");
    expect(agentWorkers).toContain("SET archived = 1");
  });

  it("keeps the default session list on chats without reclassifying human-touched agents", () => {
    expect(sidebar).toContain(
      "return stored === 'all' || stored === 'agents' || stored === 'runs' || stored === 'external' ? stored : 'chats'",
    );
    expect(sidebar).toContain("getSessionPresentationKind");
    expect(frontendAgentClassification).toContain(
      "function isPureAgentSession",
    );
    expect(sidebarSessionListModel).toContain(
      "matchesSessionListFilters(session",
    );
    expect(sessionListFilters).toContain(
      "filters.kind === 'external' && presentationKind !== 'deployment'",
    );
    expect(wsHandler).toContain("markAgentSessionHumanTouched");
    expect(wsHandler).toContain("humanChatMetadata()");
    expect(backendAgentClassification).toContain(
      "HUMAN_CHAT_SOURCE_TYPE = 'human_chat'",
    );
    expect(backendAgentClassification).toContain("metadata->>'sourceType'");
    expect(wsHandler).toContain("humanTouched");
    expect(wsHandler).toContain("'worker_human_touched'");
    expect(wsHandler).not.toContain("SET label = NULL");
    expect(wsHandler).not.toContain("'worker_human_takeover'");
    expect(sessionManager).toContain("aw.backing_session_id = s.id");
    expect(sessionManager).toContain("hasHumanInput");
    expect(sessionManager).toContain("humanTouchedSql");
    expect(sessionManager).toMatch(
      /SELECT m\.username[\s\S]*?AND \$\{humanTouchedSql\('m'\)\}[\s\S]*?\) lum ON true/,
    );
    expect(backendAgentClassification).toContain("username IS NOT NULL");
    expect(backendAgentClassification).toContain(
      "COALESCE(${messageAlias}.metadata, '{}'::jsonb) = '{}'::jsonb",
    );
  });

  it("removes the run-once subtype and creates all new subagents as persistent Agent Sessions", () => {
    expect(agentWorkers).not.toContain("export async function runOneOffAgent");
    expect(agentWorkers).not.toContain("RunOneOffAgentInput");
    expect(agentWorkers).not.toContain("trigger: 'one_off'");
    expect(agentWorkers).not.toContain("runOnce: true");
    expect(agentWorkerMcp).not.toContain("'agent_session_run_once'");
    expect(agentWorkerMcp).toContain("There is no separate run-once type");
    expect(agentWorkerMcp).toContain("task: z.string().max(8000).optional()");
  });

  it("keeps support AI quota unified per parent session across spawned sessions and Agent-backed subagents", () => {
    expect(spawnRpc).toContain("MAX_ACTIVE_CHILDREN_PER_PARENT = 10");
    expect(spawnRpc).toContain(
      "getActiveChildSessionCount(parentSessionId: string)",
    );
    expect(spawnRpc).toContain("cb.parentSessionId === parentSessionId");
    expect(spawnRpc).not.toContain("MAX_ACTIVE_PER_USER");
    expect(spawnRpc).not.toContain("MAX_ACTIVE_AGENT_PER_USER");
    expect(spawnRpc).not.toContain("quotaScope");
    expect(agentWorkers).not.toContain("quotaScope: 'agent'");
    expect(agentWorkerMcp).toContain(
      "up to 10 active callbacks per parent session",
    );
  });

  it("broadcasts injected subagent reports on the live tower_message channel", () => {
    expect(spawnRpc).toContain(
      "broadcastFn?.('tower_message', {\n    sessionId: callerSessionId",
    );
    expect(spawnRpc).not.toContain("broadcastFn?.('tower_message_session'");
    expect(frontendAgentClassification).toContain(
      "function isPureAgentSession",
    );
  });

  it("does not settle a subagent run from tool-use-only assistant rows", () => {
    expect(agentWorkers).toContain("requireText?: boolean");
    expect(agentWorkers).toContain("opts.requireText && !text");
    expect(agentWorkers).toMatch(
      /getLastAssistantMessage\(worker\.backing_session_id,\s*\{\s*requireText:\s*true,?\s*\}\)/,
    );
    expect(agentWorkers).not.toContain(
      "resultSummary || '(no assistant response yet)'",
    );
    expect(agentWorkers).toMatch(
      /latestRun\.result_summary\s*===\s*["']\(no assistant response yet\)["']/,
    );
  });

  it("requires context-rich delegation briefs rather than terse commands", () => {
    for (const text of [
      "자식이 부모 대화를 보지 못해도", "전체 로드맵·현재 단계",
      "앞뒤 마일스톤", "이번 담당 범위·비범위", "확인된 사실·미확인 가정",
      "수정 소유 범위", "중간 체크포인트", "완료 기준·검증 방법·증거",
      "보고 및 중단 조건", "후속 send에도", "보고의 간결함을 지시의 간결함으로 혼동하지 않는다",
      // Source checks protect instruction assembly only, not actual delegation quality.
      "판단 책임", "기존 팀의 업무를 이어받는 동료", "기존 검증 경로와 동작 중심 테스트",
    ]) expect(systemPrompt).toContain(text);
    expect(agentWorkerMcp).toContain("Self-contained delegation brief");
    expect(agentWorkerMcp).toContain("roadmap, current stage and milestones");
    expect(agentWorkerMcp).toContain("Context-rich follow-up");
    expect(agentWorkerMcp).toContain("do not assume the worker sees the parent conversation");
  });

  it("keeps subagent detail in backing sessions while sending compact parent reports", () => {
    expect(agentWorkers).toContain(
      "설계 결정과 대안, 관찰 사실, 재현 명령, 검증 결과는 이 backing session 또는 workspace 산출물에 남긴다",
    );
    expect(agentWorkers).toContain("PARENT_NEXT:");
    expect(agentWorkers).toContain("선택적으로 `DETAIL_ARTIFACTS:`");
    expect(agentWorkers).toContain("억지로 채우지 않는다");
    expect(agentWorkers).toContain("agentReport:");
    expect(spawnRpc).toContain("buildAgentReportAssistantContent");
    expect(spawnRpc).toContain("persistent_agent_status");
    expect(spawnRpc).toContain("sourceType: 'agent_report'");
    expect(systemPrompt).toContain(
      "도움이 될 때만 DETAIL_ARTIFACTS·READ_IF_NEEDED·PARENT_NEXT 힌트",
    );
    expect(agentWorkerMcp).toContain(
      "config.sharePublicUrl || config.publicUrl",
    );
    expect(agentWorkerMcp).toContain("sessionDeepLink(result.sessionId)");
    expect(spawnRpc).toContain("config.sharePublicUrl || config.publicUrl");
    expect(systemPrompt).toContain(
      "긴 조사 내용·툴콜 흔적·중간 메모를 부모 메시지에 그대로 붙이지 않는다",
    );
  });
});
