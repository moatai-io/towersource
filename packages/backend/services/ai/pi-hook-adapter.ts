/**
 * Owns: Adapter that lets Claude SDK PreToolUse / PostToolUse hooks run inside
 *   Pi SDK's `beforeToolCall` / `afterToolCall` agent callbacks.
 *
 * Public API:
 *   - adaptPreToolUseHookToPi(claudeHook, towerSessionId, cwd)
 *   - adaptPostToolUseHookToPi(claudeHook, towerSessionId, cwd)
 *   - PI_TO_CLAUDE_TOOL_NAME — case mapping for builtin tools
 *
 * Why this exists:
 *   Tower has 4 SDK hooks doing security / audit work (connectorGuard,
 *   sandboxPublicGate, workspaceGuard, provenance). They were written
 *   for the Claude Agent SDK Options.hooks shape. Pi SDK has a different,
 *   simpler hook shape: `beforeToolCall(ctx) => { block, reason }` and
 *   `afterToolCall(ctx) => { content?, isError?, terminate? }`.
 *
 *   Rather than re-implement 4 hooks for Pi (drift risk), we adapt the Pi
 *   context into a Claude HookInput shape and call the existing Claude
 *   hooks unchanged. Adding a new Tower hook in claude-sdk.ts now
 *   automatically gets Pi parity by wrapping it in this adapter.
 *
 * Tool-name normalization:
 *   Pi builtin tools are lowercase ('bash', 'write', 'edit', 'read', ...).
 *   Claude builtin tools are TitleCase ('Bash', 'Write', 'Edit', 'Read', ...).
 *   workspace-guard and audit/hook match on the Claude names — without
 *   normalization the matchers never fire for Pi sessions. Map both
 *   directions explicitly so the lookup is auditable.
 *
 * MCP tool names (mcp__*) are already identical between engines (Pi mounts
 *   the same in-process MCP servers), so no mapping needed there.
 *
 * See:
 *   - workspace/decisions/2026-05-17-pi-claude-parity-roadmap.md (W3)
 *   - workspace/projects/piagent/parity-roadmap-2026-05.md §W3
 *   - packages/backend/services/ai/claude-sdk.ts:503-538 (the Claude hooks
 *     wiring this adapter mirrors)
 */
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from '@earendil-works/pi-agent-core';

/** Pi-side claude-hook callback type — what we plug into createAgentSession. */
type PiBeforeToolCall = (
  ctx: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

type PiAfterToolCall = (
  ctx: AfterToolCallContext,
  signal?: AbortSignal,
) => Promise<AfterToolCallResult | undefined>;

/** The Claude SDK hook callback signature. */
type ClaudeHook = (
  input: HookInput,
  toolUseID: string | undefined,
  opts: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

/**
 * Pi builtin tool name → Claude SDK canonical name.
 * Pi uses lowercase; Claude uses TitleCase. Only matters for tools that
 * appear in Claude hook matchers (Bash / Write / Edit / NotebookEdit).
 * Unknown tools pass through unchanged so MCP and custom-tool names
 * (already identical between engines) match correctly.
 */
export const PI_TO_CLAUDE_TOOL_NAME: Record<string, string> = {
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  // Pi has no NotebookEdit equivalent — nothing to map.
  read: 'Read',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS',
};

function normalizeToolName(piName: string): string {
  return PI_TO_CLAUDE_TOOL_NAME[piName] ?? piName;
}

/**
 * Pull a usable cwd out of Pi's AgentContext. Pi's context shape can vary
 * across versions — we look for a string `cwd` field first, then fall back
 * to the caller-supplied default.
 */
function extractCwd(ctx: BeforeToolCallContext | AfterToolCallContext, fallback: string): string {
  const anyCtx = ctx.context as { cwd?: unknown };
  if (typeof anyCtx?.cwd === 'string' && anyCtx.cwd.length > 0) return anyCtx.cwd;
  return fallback;
}

/**
 * Build a minimal Claude HookInput from Pi's tool-call context.
 * Fields the existing Claude hooks actually read:
 *   - hook_event_name  → distinguishes Pre vs Post in the hook body
 *   - tool_name        → matcher key (Bash / Write / mcp__... etc)
 *   - tool_input       → path / command extraction
 *   - cwd              → resolves relative paths
 *   - session_id       → SDK turn-level id; we don't have a Pi turn id,
 *                        so we forward the stable Tower session id, which
 *                        is what /commit-session greps for anyway
 */
function buildHookInput(
  eventName: 'PreToolUse' | 'PostToolUse',
  ctx: BeforeToolCallContext | AfterToolCallContext,
  towerSessionId: string,
  cwd: string,
  /** afterToolCall has a `result` field — only used for PostToolUse. */
  result?: unknown,
): HookInput {
  const toolName = normalizeToolName(ctx.toolCall.name);
  // Pi gives both `args` (validated) and `toolCall.arguments` (raw).
  // Prefer `args` — it's what the tool would actually receive.
  const toolInput =
    (ctx.args && typeof ctx.args === 'object'
      ? (ctx.args as Record<string, unknown>)
      : (ctx.toolCall.arguments as Record<string, unknown>)) ?? {};

  const base = {
    hook_event_name: eventName,
    tool_name: toolName,
    tool_input: toolInput,
    cwd,
    session_id: towerSessionId,
  };
  if (eventName === 'PostToolUse' && result !== undefined) {
    return { ...base, tool_response: result } as unknown as HookInput;
  }
  return base as unknown as HookInput;
}

/**
 * Wrap one Claude PreToolUse hook in a Pi `beforeToolCall` callback.
 *
 * Optional `matcher` mirrors the SDK Options.hooks { matcher, hooks } shape:
 * a regex that, if provided, must match the (normalized) tool name. Hooks
 * that should apply to every tool (e.g. connectorGuard which has its own
 * internal pattern) omit the matcher.
 *
 * Translation rules:
 *   - Claude hook returns `{ continue: true }` → Pi `undefined` (allow)
 *   - Claude hook returns `{ decision: 'block', reason, ... }` → Pi
 *     `{ block: true, reason }`
 *   - Claude hook returns `{ hookSpecificOutput: { permissionDecision: 'deny' } }`
 *     → same Pi block (covers the newer SDK output shape)
 *   - Hook throws → log + allow (never break the agent loop)
 */
export function adaptPreToolUseHookToPi(
  claudeHook: ClaudeHook,
  towerSessionId: string,
  defaultCwd: string,
  matcher?: RegExp,
): PiBeforeToolCall {
  return async (ctx, signal) => {
    const toolName = normalizeToolName(ctx.toolCall.name);
    if (matcher && !matcher.test(toolName)) return undefined;

    const cwd = extractCwd(ctx, defaultCwd);
    const input = buildHookInput('PreToolUse', ctx, towerSessionId, cwd);
    const abortSignal = signal ?? new AbortController().signal;

    let result: HookJSONOutput;
    try {
      result = await claudeHook(input, ctx.toolCall.id, { signal: abortSignal });
    } catch (err) {
      console.warn('[pi-hook-adapter] PreToolUse hook threw — allowing:', err);
      return undefined;
    }

    // Newer SDK shape: hookSpecificOutput.permissionDecision === 'deny'
    const hso = (result as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } })
      .hookSpecificOutput;
    if (hso?.permissionDecision === 'deny') {
      return {
        block: true,
        reason: hso.permissionDecisionReason || (result as { reason?: string }).reason || 'blocked',
      };
    }
    // Legacy shape: { decision: 'block', reason }
    if ((result as { decision?: string }).decision === 'block') {
      return {
        block: true,
        reason: (result as { reason?: string }).reason || 'blocked',
      };
    }
    return undefined; // allow (covers { continue: true } and any other allow shape)
  };
}

/**
 * Wrap one Claude PostToolUse hook in a Pi `afterToolCall` callback.
 *
 * PostToolUse hooks in our codebase are audit / tracking only — they never
 * mutate the tool result. So we always return `undefined` (no override) and
 * swallow any error to avoid breaking the agent loop.
 */
export function adaptPostToolUseHookToPi(
  claudeHook: ClaudeHook,
  towerSessionId: string,
  defaultCwd: string,
  matcher?: RegExp,
): PiAfterToolCall {
  return async (ctx, signal) => {
    const toolName = normalizeToolName(ctx.toolCall.name);
    if (matcher && !matcher.test(toolName)) return undefined;

    const cwd = extractCwd(ctx, defaultCwd);
    const input = buildHookInput('PostToolUse', ctx, towerSessionId, cwd, ctx.result);
    const abortSignal = signal ?? new AbortController().signal;

    try {
      await claudeHook(input, ctx.toolCall.id, { signal: abortSignal });
    } catch (err) {
      console.warn('[pi-hook-adapter] PostToolUse hook threw — ignoring:', err);
    }
    return undefined;
  };
}

/**
 * Compose multiple Pi `beforeToolCall` callbacks into one. First block wins;
 * if every callback returns undefined the chain returns undefined (allow).
 *
 * Used by pi-engine to chain connectorGuard → sandboxPublicGate → workspaceGuard
 * in the same order Claude SDK runs them.
 */
export function chainBeforeToolCallHooks(
  hooks: PiBeforeToolCall[],
): PiBeforeToolCall {
  return async (ctx, signal) => {
    for (const hook of hooks) {
      const result = await hook(ctx, signal);
      if (result?.block) return result;
    }
    return undefined;
  };
}

/**
 * Compose multiple Pi `afterToolCall` callbacks. All run sequentially. None
 * of our PostToolUse hooks override the result, so we ignore individual
 * returns and always return undefined.
 */
export function chainAfterToolCallHooks(
  hooks: PiAfterToolCall[],
): PiAfterToolCall {
  return async (ctx, signal) => {
    for (const hook of hooks) {
      await hook(ctx, signal);
    }
    return undefined;
  };
}
