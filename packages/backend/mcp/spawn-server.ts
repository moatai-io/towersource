/**
 * spawn-server.ts — In-process MCP server exposing L3 session-spawn tools to Claude.
 *
 * Owns: thin adapter — closure-binds parentSessionId / parentUserId so the AI
 *       cannot forge them as tool arguments. All real work delegated to
 *       services/session/spawn-rpc.ts.
 *
 * Tools:
 *   - spawn_session         — create a new sidebar peer session
 *   - delete_spawned_session — soft-delete a session this one spawned
 *
 * Mount policy: claude-engine mounts this MCP server for every session that
 * has a userId (the owner). The tool description carries the AI usage policy
 * (do NOT self-spawn; only on user request or skill invocation).
 *
 * Decision: workspace/decisions/2026-05-09-l3-session-spawn-rpc.md
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  deleteSpawnedSession,
  sendToSpawnedSession,
  sendToSession,
  listSpawnedSessions,
  getSpawnedResponse,
} from "../services/session/spawn-rpc.js";
import { createSessionConversation } from "../services/session/session-conversation-service.js";
import { getCurrentRootTurn } from "../services/agent-turn/current-root-turn.js";
import { getSession } from "../services/session/session-manager.js";

export interface SpawnMcpContext {
  parentSessionId: string;
  parentUserId: number;
  parentUsername?: string;
  parentRole?: string;
}

/** Resolve the caller session's display name once per tool call (small DB lookup). */
async function resolveCallerName(parentSessionId: string): Promise<string> {
  try {
    const s = await getSession(parentSessionId);
    return s?.name || `session ${parentSessionId.slice(0, 8)}`;
  } catch {
    return `session ${parentSessionId.slice(0, 8)}`;
  }
}

const SPAWN_DESCRIPTION = [
  "Create a new Tower session as a sidebar peer. The new session appears in",
  "the user's sidebar, runs the given prompt in the background, and (by default)",
  "reports its final answer back to THIS session and wakes the caller to continue.",
  "",
  "⚠️ POLICY — DO NOT call this on your own initiative. Call ONLY when one of:",
  "  (1) the user EXPLICITLY asks for a separate / sidebar / parallel / spawned session,",
  '      e.g. "사이드바에 새 세션 띄워서 ~", "별도 세션으로 ~", "병렬로 ~", "spawn ~"',
  "  (2) the active skill's SKILL.md explicitly invokes spawn_session as part of its flow",
  "      (e.g. /research, /best-of-n).",
  "",
  "For routine sub-tasks (search, multi-file investigation, parallel analysis) where",
  "sidebar visibility is NOT needed, use the built-in Task/Agent tool instead — it is",
  "in-process, faster, and does not consume the user's sidebar attention.",
  "",
  "Use spawn_session when sidebar visibility carries value:",
  "  • the user wants to see / interrupt / cite the child session",
  "  • the result will outlive this turn (decision, ongoing thread)",
  "  • the child needs to run while the parent continues",
  "",
  "Quotas (hard caps): max 10 active child/support sessions per parent session, max depth 3 from a root",
  "session. Calls beyond these limits fail with SPAWN_QUOTA_EXCEEDED /",
  "SPAWN_DEPTH_EXCEEDED.",
].join("\n");

const DELETE_DESCRIPTION = [
  "Soft-delete a session that THIS session previously spawned via spawn_session.",
  "Hides the child from the sidebar but preserves its messages for later",
  "reference (archived=1, recoverable). Only the parent that spawned the child",
  "can delete it.",
  "",
  "Use this to clean up after an inject-parent spawn whose answer you have",
  "already integrated into your reply, so the user's sidebar stays tidy.",
].join("\n");

/**
 * Mount once per session. ctx.parentSessionId / parentUserId are closure-captured
 * so the AI cannot pretend to be a different parent.
 */
export function createSpawnMcpServer(ctx: SpawnMcpContext) {
  return createSdkMcpServer({
    name: "tower-spawn",
    version: "0.1.0",
    tools: [
      tool(
        "spawn_session",
        SPAWN_DESCRIPTION,
        {
          prompt: z
            .string()
            .min(1)
            .describe(
              "The full task / question to give the new session. Be specific — the child does not see this conversation by default.",
            ),
          name: z
            .string()
            .min(1)
            .max(80)
            .describe(
              'Sidebar label shown to the user, e.g. "보안 검토 — L3 spawn". Keep concise.',
            ),
          engine: z
            .enum(["claude", "pi"])
            .optional()
            .describe(
              "Engine for the spawned session. Omit to use Tower's configured DEFAULT_ENGINE for this VM. " +
                '"claude" uses Anthropic Claude Agent SDK. ' +
                '"pi" uses @earendil-works/pi-coding-agent SDK and supports Tower AI Router / OpenRouter models.',
            ),
          model: z
            .string()
            .optional()
            .describe(
              "Model id. Omit to use this VM's admin-configured session default for the selected engine. " +
                'For Pi-first Tower VMs this stores "preset/core" and resolves the current admin Core mapping at run time. ' +
                'For engine="claude", use a Claude SDK alias like "claude-sonnet-4-6". ' +
                'For engine="pi", use "preset/core", "preset/lite", or an explicitly registered provider-prefixed id such as ' +
                '"openrouter/moonshotai/kimi-k2.6" (see packages/backend/models.json pi array for the registered list).',
            ),
          context_summary: z
            .string()
            .max(8000)
            .optional()
            .describe(
              "Optional 1–2 paragraph context preface prepended to the prompt so the new session understands what the parent is doing.",
            ),
          on_complete: z
            .enum(["wake", "inject", "none"])
            .optional()
            .describe(
              "Default wake/report-and-resume: child final answer reports back and automatically triggers parent engine.run. " +
                "inject: report-only delivery without auto-resuming parent. " +
                "none: rare muted/background exception; manual readback only.",
            ),
        },
        async (args, extra) => {
          try {
            const rootTurnId = getCurrentRootTurn(ctx.parentSessionId);
            const toolCallId =
              typeof (extra as any)?.toolCallId === "string"
                ? (extra as any).toolCallId
                : undefined;
            const result = await createSessionConversation({
              sourceSessionId: ctx.parentSessionId,
              sourceUserId: ctx.parentUserId,
              sourceUsername: ctx.parentUsername,
              sourceRole: ctx.parentRole || "member",
              sourceRootTurnId: rootTurnId,
              operationId:
                rootTurnId && toolCallId
                  ? `${rootTurnId}:spawn:${toolCallId}`
                  : undefined,
              prompt: args.prompt,
              name: args.name,
              engine: args.engine,
              model: args.model,
              contextSummary: args.context_summary,
              onComplete:
                args.on_complete === "none"
                  ? { mode: "none" as const }
                  : args.on_complete === "inject"
                    ? { mode: "inject-only" as const }
                    : { mode: "inject-and-wake" as const },
            });
            const completionNote =
              args.on_complete === "none"
                ? "Muted/background — read the child manually when needed."
                : args.on_complete === "inject"
                  ? "Its final answer will be reported here without auto-resuming the parent."
                  : "Its final answer will report back here and auto-resume this session.";
            return {
              content: [
                {
                  type: "text" as const,
                  text: result.deduplicated
                    ? `Duplicate spawn retry detected; reused existing session "${args.name}" ` +
                      `(id=${result.sessionId}, spawnId=${result.spawnId}). No second session was created. ${completionNote}`
                    : `Spawned session "${args.name}" (id=${result.sessionId}, spawnId=${result.spawnId}). ` +
                      `Visible in the sidebar now and running in background. ${completionNote}`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `spawn_session failed: ${err?.code || ""} ${err?.message || String(err)}`.trim(),
                },
              ],
              isError: true,
            };
          }
        },
      ),
      tool(
        "delete_spawned_session",
        DELETE_DESCRIPTION,
        {
          session_id: z
            .string()
            .min(1)
            .describe(
              "The id of the spawned child session to soft-delete (returned from spawn_session).",
            ),
        },
        async (args) => {
          try {
            const ok = await deleteSpawnedSession(
              ctx.parentSessionId,
              args.session_id,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: ok
                    ? `Soft-deleted session ${args.session_id.slice(0, 8)} (archived; recoverable).`
                    : `Session ${args.session_id.slice(0, 8)} could not be deleted (may already be archived).`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `delete_spawned_session failed: ${err?.code || ""} ${err?.message || String(err)}`.trim(),
                },
              ],
              isError: true,
            };
          }
        },
      ),
      // ── Phase 2 (2026-05-09) ─────────────────────────────────────────
      // Decision: workspace/decisions/2026-05-09-l3-spawn-phase2-orchestration.md
      tool(
        "send_to_spawned_session",
        [
          "Send a follow-up message to a session THIS session previously spawned.",
          "The child resumes its existing context, processes the message, and its",
          "final answer reports back to THIS session. Default behavior wakes the caller to continue.",
          "",
          "⚠️ POLICY — call only on explicit user request or skill flow, not on AI initiative.",
          "",
          'on_complete (default "wake"):',
          '  • "wake"   — report-and-resume: answer returns as agent-origin user message and this session auto-continues.',
          '  • "inject" — report-only: answer appears here but parent does not auto-resume.',
          '  • "none"   — muted/background exception; readback via get_spawned_response.',
          "",
          "Use to continue an ongoing conversation with a spawn child. In ordinary delegation, omit on_complete and receive the report automatically.",
          "",
          "Errors: NOT_PARENT (caller did not spawn this child), CHILD_NOT_FOUND,",
          "TARGET_STREAMING (child currently responding), SEND_RATE_LIMIT (10/min cap),",
          "SEND_LOOP (ping-pong detected).",
        ].join("\n"),
        {
          session_id: z
            .string()
            .min(1)
            .describe(
              "Spawned child session id (from spawn_session). Full UUID preferred (e.g. b34b0022-7808-439d-9a4e-9eeabf9f2ba2). 6+ char unique prefix among your own children also accepted; ambiguous prefix → AMBIGUOUS_PREFIX error.",
            ),
          message: z
            .string()
            .min(1)
            .describe(
              "The follow-up message. Sent verbatim — no system framing added.",
            ),
          on_complete: z
            .enum(["wake", "inject", "none"])
            .optional()
            .describe(
              "Default wake/report-and-resume. inject = report-only without auto-resuming parent. none = rare muted/background exception.",
            ),
        },
        async (args) => {
          try {
            const callerName = await resolveCallerName(ctx.parentSessionId);
            await sendToSpawnedSession({
              callerSessionId: ctx.parentSessionId,
              callerSessionName: callerName,
              callerUserId: ctx.parentUserId,
              callerRole: ctx.parentRole || "member",
              childSessionId: args.session_id,
              message: args.message,
              onComplete: args.on_complete || "wake",
            });
            const noticeByMode =
              args.on_complete === "inject"
                ? `Sent to spawned session ${args.session_id.slice(0, 8)} (mode=inject/report-only). Its answer will appear here without auto-resume.`
                : args.on_complete === "none"
                  ? `Sent to spawned session ${args.session_id.slice(0, 8)} (mode=none, muted/background). Read back via get_spawned_response.`
                  : `Sent to spawned session ${args.session_id.slice(0, 8)} (mode=wake/report-and-resume). When child finishes, this session will auto-resume.`;
            return {
              content: [{ type: "text" as const, text: noticeByMode }],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `send_to_spawned_session failed: ${err?.code || ""} ${err?.message || String(err)}`.trim(),
                },
              ],
              isError: true,
            };
          }
        },
      ),
      tool(
        "send_to_session",
        [
          "Send a message to ANY session (not just sessions THIS one spawned).",
          "The target resumes its context, processes the message, and its final",
          "answer reports back to THIS session. Default behavior wakes the caller to continue.",
          "",
          "⚠️ POLICY — call only on explicit user request or skill flow, not on AI initiative.",
          "",
          "Permission:",
          "  • target.user_id == caller.user_id  → OK (your own sessions)",
          '  • caller.role == "admin"            → OK (any session)',
          "  • otherwise                         → SEND_PERMISSION_DENIED",
          "",
          'on_complete (default "wake"):',
          '  • "wake"   — report-and-resume: answer returns as agent-origin user message and this session auto-continues.',
          '  • "inject" — report-only: answer appears here but parent does not auto-resume.',
          '  • "none"   — muted/background exception.',
          "",
          "Use to interject into an existing conversation; in ordinary delegation, omit on_complete and receive the report automatically.",
          "",
          "Errors: TARGET_NOT_FOUND, SEND_PERMISSION_DENIED, TARGET_STREAMING,",
          "SEND_RATE_LIMIT, SEND_LOOP, SEND_TO_SELF.",
        ].join("\n"),
        {
          session_id: z.string().min(1).describe("Target session id."),
          message: z
            .string()
            .min(1)
            .describe(
              "Message to send. Sent verbatim with caller-name prefix only.",
            ),
          on_complete: z
            .enum(["wake", "inject", "none"])
            .optional()
            .describe(
              "Default wake/report-and-resume. inject = report-only without auto-resuming parent. none = rare muted/background exception.",
            ),
        },
        async (args) => {
          try {
            const callerName = await resolveCallerName(ctx.parentSessionId);
            await sendToSession({
              callerSessionId: ctx.parentSessionId,
              callerSessionName: callerName,
              callerUserId: ctx.parentUserId,
              callerRole: ctx.parentRole || "member",
              targetSessionId: args.session_id,
              message: args.message,
              onComplete: args.on_complete || "wake",
            });
            const modeLabel =
              args.on_complete === "inject"
                ? "inject/report-only (answer will appear here without auto-resume)"
                : args.on_complete === "none"
                  ? "none (muted/background)"
                  : "wake/report-and-resume (will auto-trigger this session when done)";
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Sent to session ${args.session_id.slice(0, 8)} [${modeLabel}].`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `send_to_session failed: ${err?.code || ""} ${err?.message || String(err)}`.trim(),
                },
              ],
              isError: true,
            };
          }
        },
      ),
      tool(
        "get_spawned_response",
        [
          "Read the current last-assistant-text + status of a session THIS one spawned.",
          "Use for fan-in patterns — collecting / aggregating / quoting child results.",
          "",
          "Compared to list_spawned_sessions which only gives status + timestamps,",
          "this returns the actual response text so the parent AI can summarize,",
          "compare, vote, or merge multiple child outputs.",
          "",
          "Permission: parent_session_id == caller (only your own children, same as list).",
          "Errors: CHILD_NOT_FOUND, NOT_PARENT.",
          "",
          "Typical Map-Reduce / fan-in flow:",
          '  1. spawn N children (default report-and-resume) or explicitly use on_complete="inject" for report-only',
          "  2. wait for done (default auto-wake resumes you)",
          "  3. for each child: get_spawned_response → collect",
          "  4. summarize / merge / present to user",
        ].join("\n"),
        {
          session_id: z
            .string()
            .min(1)
            .describe(
              "Spawned child session id (from spawn_session). Full UUID preferred (e.g. b34b0022-7808-439d-9a4e-9eeabf9f2ba2). 6+ char unique prefix among your own children also accepted; ambiguous prefix → AMBIGUOUS_PREFIX error.",
            ),
        },
        async (args) => {
          try {
            const info = await getSpawnedResponse(
              ctx.parentSessionId,
              args.session_id,
            );
            const preview =
              info.lastResponse.length > 4000
                ? info.lastResponse.slice(0, 4000) + "\n…[truncated]"
                : info.lastResponse;
            const status = info.status;
            const summary = `[${status}] ${args.session_id.slice(0, 8)} — ${info.messageCount} msgs, last ${info.lastMessageAt || "(none)"}\n\n${preview || "(no assistant response yet)"}`;
            return {
              content: [{ type: "text" as const, text: summary }],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `get_spawned_response failed: ${err?.code || ""} ${err?.message || String(err)}`.trim(),
                },
              ],
              isError: true,
            };
          }
        },
      ),
      tool(
        "list_spawned_sessions",
        [
          "List all sessions spawned by THIS session, with current status (running /",
          "idle / archived) and last-message timestamp. Use to recall what children",
          "exist before sending follow-up messages, or to decide which to delete.",
          "",
          "For the actual answer text of a child, use get_spawned_response.",
          "",
          "Returns at most 50 most-recent children, including archived ones.",
        ].join("\n"),
        {},
        async () => {
          try {
            const list = await listSpawnedSessions(ctx.parentSessionId);
            if (list.length === 0) {
              return {
                content: [
                  { type: "text" as const, text: "No spawned children yet." },
                ],
              };
            }
            const lines = list
              .slice(0, 50)
              .map(
                (c) =>
                  `- ${c.sessionId.slice(0, 8)} [${c.status}] "${c.name}" — created ${c.createdAt}, last msg ${c.lastMessageAt || "(none)"}`,
              );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Spawned children (${list.length}):\n${lines.join("\n")}`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `list_spawned_sessions failed: ${err?.message || String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
