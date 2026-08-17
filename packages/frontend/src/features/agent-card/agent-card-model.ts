// Owns: parsing and stable display model helpers for agent launch cards.
// Public API: isAgentTool, parseAgentWorkerResult, getAgentCardTitle/Type/PromptPreview.
// See README.md and _DECISIONS.md.

export type AgentWorkerResultMeta = {
  workerId?: string;
  backingSessionId?: string;
  runId?: string;
  mode?: string;
  name?: string;
  role?: string;
  face?: string;
  tagline?: string;
};

function safeStr(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function parseResultField(text: string, field: string): string {
  const raw = text
    .match(new RegExp(`^\\s*-?\\s*${field}:\\s*(.+)$`, "im"))?.[1]
    ?.trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return safeStr(parsed);
  } catch {
    return raw;
  }
}

export function normalizeAgentToolName(name?: string): string {
  return (name || "")
    .trim()
    .replace(/^functions\./, "")
    .replace(/^mcp__agent-worker__/, "")
    .replace(/^mcp__tower-spawn__/, "");
}

export function isAgentWorkerTool(name?: string): boolean {
  const n = normalizeAgentToolName(name);
  return (
    n === "agent_session_run_once" ||
    n === "persistent_agent_create" ||
    n === "persistent_agent_send" ||
    n === "spawn_session" ||
    n === "send_to_spawned_session" ||
    n === "send_to_session"
  );
}

export function isAgentTool(name?: string): boolean {
  if (!name) return false;
  const n = normalizeAgentToolName(name);
  const legacyName = n.charAt(0).toUpperCase() + n.slice(1);
  return (
    legacyName === "Task" || legacyName === "Agent" || isAgentWorkerTool(name)
  );
}

export function getAgentCardTitle(
  toolName: string,
  input: Record<string, any>,
): string {
  const n = normalizeAgentToolName(toolName);
  if (n === "agent_session_run_once")
    return safeStr(input.name || input.role || "Run-once subagent");
  if (n === "persistent_agent_create")
    return safeStr(input.name || input.role || "Persistent subagent");
  if (n === "persistent_agent_send")
    return safeStr(input.worker || input.message || "Agent");
  if (n === "spawn_session") return safeStr(input.name || "Agent");
  if (n === "send_to_spawned_session" || n === "send_to_session")
    return "Agent 대화";
  return safeStr(input.description || input.name || "Agent");
}

export function getAgentCardType(
  toolName: string,
  input: Record<string, any>,
): string {
  const n = normalizeAgentToolName(toolName);
  if (n === "agent_session_run_once") return "run-once";
  if (n === "persistent_agent_create") return "create";
  if (n === "persistent_agent_send")
    return input.on_complete ? `send · ${input.on_complete}` : "send";
  return safeStr(input.subagent_type || "");
}

export function getAgentPromptPreview(
  toolName: string,
  input: Record<string, any>,
): string {
  const n = normalizeAgentToolName(toolName);
  if (n === "agent_session_run_once")
    return safeStr(input.task || input.instruction || input.role || "");
  if (n === "persistent_agent_create")
    return safeStr(input.instruction || input.goal || input.role || "");
  if (
    n === "persistent_agent_send" ||
    n === "send_to_spawned_session" ||
    n === "send_to_session"
  )
    return safeStr(input.message || "");
  if (n === "spawn_session") return safeStr(input.prompt || "");
  return safeStr(input.prompt || "");
}

export function parseAgentWorkerResult(
  result?: string,
  input: Record<string, any> = {},
): AgentWorkerResultMeta | null {
  if (!result && !input.worker && !input.on_complete) return null;
  const text = result || "";
  const workerId =
    text.match(/workerId:\s*([0-9a-f-]{8,})/i)?.[1] ||
    text.match(/Sent to persistent agent\s+([0-9a-f-]{8,})/i)?.[1] ||
    safeStr(input.worker || "");
  const backingSessionId =
    text.match(/backingSessionId:\s*([0-9a-f-]{8,})/i)?.[1] ||
    text.match(/\(id=([0-9a-f-]{8,})/i)?.[1];
  const runId = text.match(/(?:initialRunId|runId):\s*([0-9a-f-]{8,})/i)?.[1];
  const mode =
    text.match(/mode:\s*([^\n]+)/i)?.[1]?.trim() ||
    safeStr(input.on_complete || "");
  const name = parseResultField(text, "agentName") || safeStr(input.name || "");
  const role = parseResultField(text, "agentRole") || safeStr(input.role || "");
  const face = parseResultField(text, "agentFace") || safeStr(input.face || "");
  const tagline =
    parseResultField(text, "agentTagline") || safeStr(input.tagline || "");
  if (
    !workerId &&
    !backingSessionId &&
    !runId &&
    !mode &&
    !name &&
    !role &&
    !face &&
    !tagline
  )
    return null;
  return { workerId, backingSessionId, runId, mode, name, role, face, tagline };
}

export function shortAgentId(id?: string): string {
  return id ? id.slice(0, 8) : "";
}
