/**
 * Owns: PreToolUse hook + disallowedTools list for multi-tenant claude.ai
 *   connector blocking. Catch-all guard against the single-user-CLI assumption
 *   leaking into our multi-user web environment.
 * Public API:
 *   - BLOCKED_TOOL_NAMES   — explicit list for SDK `disallowedTools`
 *   - BLOCKED_TOOL_PATTERNS — regex catch-all for current/future connectors
 *   - preToolUseConnectorGuard — SDK PreToolUse hook callback
 *
 * Why this exists:
 *   Claude Code SDK is designed around a single-user CLI. In Tower's
 *   multi-tenant web backend, `mcp__claude_ai_*` connector tools are
 *   auto-injected by the `tengu_claudeai_mcp_connectors` flag whenever
 *   the backend authenticates with an OAuth account. A tool call from
 *   ANY user session executes with the BACKEND's OAuth credentials —
 *   leaking admin's Notion / Slack / Drive / Calendar / Gmail across
 *   tenants. SDK has no `disableConnectors` option (GitHub #22301,
 *   #26625, #20412 — all unresolved), so we intercept here.
 *
 * Defense layers (decision: workspace/decisions/2026-05-11-mcp-multi-tenant-policy.md):
 *   1. SDK `disallowedTools` (claude-sdk.ts) — removes schema from prompt + token savings
 *   2. PreToolUse hook (this file)            — regex catch-all for tools added later
 *   3. System prompt guard (system-prompt.ts) — instructs AI to never suggest /mcp
 *   4. (Phase 2) boot-time connector count check — guards against operator re-enabling
 */
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Catch-all regex for any current OR future claude.ai connector tool, plus the
 * meta tools used to enumerate / read connector resources. Used by the
 * PreToolUse hook below — guards against connectors added by Anthropic later
 * (we won't have to update BLOCKED_TOOL_NAMES manually for the regex to match).
 */
export const BLOCKED_TOOL_PATTERNS: RegExp[] = [
  /^mcp__claude_ai_/i,        // any current/future claude.ai-namespaced connector
  /^ListMcpResourcesTool$/,   // meta — would expose connector list
  /^ReadMcpResourceTool$/,    // meta — would read connector resources
];

/**
 * Explicit list for SDK `disallowedTools` (currently observed connectors as of
 * 2026-05-11). Removes schema from the model's context (saves tokens + prevents
 * the AI from even attempting the call).
 *
 * The regex hook above is the catch-all for tools added later by Anthropic;
 * this list is the "remove from context" optimization.
 */
export const BLOCKED_TOOL_NAMES: string[] = [
  // Google
  'mcp__claude_ai_Google_Drive__authenticate',
  'mcp__claude_ai_Google_Drive__complete_authentication',
  'mcp__claude_ai_Google_Calendar__authenticate',
  'mcp__claude_ai_Google_Calendar__complete_authentication',
  // Notion
  'mcp__claude_ai_Notion__notion-create-comment',
  'mcp__claude_ai_Notion__notion-create-database',
  'mcp__claude_ai_Notion__notion-create-pages',
  'mcp__claude_ai_Notion__notion-create-view',
  'mcp__claude_ai_Notion__notion-duplicate-page',
  'mcp__claude_ai_Notion__notion-fetch',
  'mcp__claude_ai_Notion__notion-get-comments',
  'mcp__claude_ai_Notion__notion-get-teams',
  'mcp__claude_ai_Notion__notion-get-users',
  'mcp__claude_ai_Notion__notion-move-pages',
  'mcp__claude_ai_Notion__notion-search',
  'mcp__claude_ai_Notion__notion-update-data-source',
  'mcp__claude_ai_Notion__notion-update-page',
  'mcp__claude_ai_Notion__notion-update-view',
  // Slack
  'mcp__claude_ai_Slack__slack_create_canvas',
  'mcp__claude_ai_Slack__slack_read_canvas',
  'mcp__claude_ai_Slack__slack_read_channel',
  'mcp__claude_ai_Slack__slack_read_thread',
  'mcp__claude_ai_Slack__slack_read_user_profile',
  'mcp__claude_ai_Slack__slack_schedule_message',
  'mcp__claude_ai_Slack__slack_search_channels',
  'mcp__claude_ai_Slack__slack_search_public',
  'mcp__claude_ai_Slack__slack_search_public_and_private',
  'mcp__claude_ai_Slack__slack_search_users',
  'mcp__claude_ai_Slack__slack_send_message',
  'mcp__claude_ai_Slack__slack_send_message_draft',
  'mcp__claude_ai_Slack__slack_update_canvas',
  // Meta tools (would enable connector enumeration / resource read)
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  // Tower 자체 unified-scheduler 가 있어 Anthropic SDK 의 cron routine 시스템과
  // 충돌. CronCreate/List/Delete 가 호출되면 사용자 가시성 (태스크 탭) 없는
  // 별도 cron 이 만들어져 혼란. ScheduleWakeup 은 살려둠 (dynamic loop 의
  // fallback 용도). 근거: workspace/decisions/2026-05-16-task-schedule-unification.md
  'CronCreate',
  'CronList',
  'CronDelete',
  // SDK built-in task tools — Tower 자체 task 시스템 (/task-schedule 스킬,
  // unified-scheduler, kanban board) 과 충돌. 더 중요한 부작용: SDK 가 이
  // 도구들을 tool list 에서 발견하면 "The task tools haven't been used recently"
  // system-reminder 를 매 턴 주입해 시스템 프롬프트에 잡음을 만들고 AI 가
  // 태스크 트래커를 언급하는 문제 유발.
  // lMY() 함수 조건: !K.options.tools.some(Y => e3(Y, "TaskUpdate")) → early return
  // → 이 도구들을 disallowedTools 에 넣으면 tool list 에서 제거 → reminder 억제.
  // 근거: workspace/decisions/2026-05-16-task-schedule-unification.md
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TaskStop',
];

/** Returns true if the tool name matches any BLOCKED_TOOL_PATTERNS regex. */
function isBlocked(toolName: string): boolean {
  return BLOCKED_TOOL_PATTERNS.some((re) => re.test(toolName));
}

const DENY_REASON = [
  'claude.ai connector 사용 금지 (multi-tenant 격리 정책).',
  '이 도구는 backend OAuth 계정 단위로 묶여 있어 다른 사용자 세션에 자격증명이 노출됩니다.',
  '대신 Tower 가 제공하는 in-process MCP 또는 gws CLI 사용.',
  '정책: workspace/decisions/2026-05-11-mcp-multi-tenant-policy.md',
].join(' ');

/**
 * SDK PreToolUse callback. Returns deny when the requested tool is a
 * claude.ai connector (or meta resource tool). Always logs to stderr for
 * audit; the PostToolUse provenance pipeline picks up the denial event.
 *
 * Hook return shape (sdk.d.ts:1682-1688 PreToolUseHookSpecificOutput +
 * SyncHookJSONOutput): both legacy `decision: 'block'` and new
 * `hookSpecificOutput.permissionDecision: 'deny'` are emitted for forward
 * compatibility with SDK upgrades.
 */
export async function preToolUseConnectorGuard(
  input: HookInput,
  _toolUseID: string | undefined,
  _opts: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') return { continue: true };
  const toolName = input.tool_name ?? '';
  if (!isBlocked(toolName)) return { continue: true };

  console.warn(`[connector-guard] blocked tool=${toolName}`);

  return {
    decision: 'block',
    reason: DENY_REASON,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    },
  };
}
