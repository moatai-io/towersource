// Owns: Pi tool wrapper that applies the durable side-effect ledger.
// Public API: wrapToolsWithSideEffectLedger. See README.md.

import type { ToolActionClassification } from '../authority/execution-gate-shadow.js';
import { classifyToolExecutionAction } from '../authority/execution-gate-shadow.js';
import { getCurrentRootTurn, isCurrentRootTurnRecovering } from './current-root-turn.js';
import {
  beginSideEffectExecution,
  buildSideEffectSemanticHash,
  failSideEffectExecution,
  finishSideEffectExecution,
} from './side-effect-ledger.js';

const SAFE_READ_TOOLS = new Set([
  'read', 'grep', 'find', 'ls', 'excel_read', 'excel_query', 'excel_diff',
  'pdf_read', 'pdf_view', 'cad_view', 'webfetch', 'websearch', 'memory_search',
  'conversation_search', 'session_transcript_read', 'sharedtasklist',
  'service_list', 'service_logs', 'mcp__agent-worker__persistent_agent_list',
  'mcp__agent-worker__persistent_agent_status',
  'mcp__tower-spawn__list_spawned_sessions', 'mcp__tower-spawn__get_spawned_response',
]);
const UNGUARDED_TOOLS = new Set([
  'askuserquestion',
  'todowrite',
  'mcp__tower-spawn__get_spawned_response',
  'mcp__tower-spawn__list_spawned_sessions',
]);

/** Whether a classified Pi tool can create an externally visible or durable side effect. */
export function shouldGuardSideEffectTool(toolName: string, classification: ToolActionClassification): boolean {
  const normalized = toolName.toLowerCase();
  if (UNGUARDED_TOOLS.has(normalized) || SAFE_READ_TOOLS.has(normalized)) return false;
  if ((normalized === 'bash' || normalized === 'project_shell') && classification.actionClass === 'read') return false;
  // Unknown custom/MCP tools fail toward guarded execution rather than trusting
  // the shadow classifier's legacy read fallback.
  return true;
}

function toolResult(text: string, isError = false): any {
  return { content: [{ type: 'text', text }], details: undefined, isError };
}

/** Apply at-most-once recovery semantics to every non-read Pi tool at the common dispatch boundary. */
export function wrapToolsWithSideEffectLedger<T extends { name?: string; execute?: (...args: any[]) => any }>(
  tools: T[],
  ctx: { sessionId: string },
): T[] {
  return tools.map(tool => {
    if (!tool?.execute) return tool;
    const toolName = tool.name || 'unknown';
    const origExecute = tool.execute;
    return {
      ...tool,
      execute: async (...args: any[]) => {
        const toolCallId = String(args[0] || 'unknown');
        const params = args[1] ?? {};
        const classification = classifyToolExecutionAction(toolName, params);
        if (!shouldGuardSideEffectTool(toolName, classification)) {
          return origExecute.call(tool, ...args);
        }
        const rootTurnId = getCurrentRootTurn(ctx.sessionId);
        if (!rootTurnId) {
          // Synthetic/eval/background routes without a root user turn retain
          // their existing behavior; automatic recovery itself fails closed.
          return origExecute.call(tool, ...args);
        }
        const claim = await beginSideEffectExecution({
          rootTurnId,
          sessionId: ctx.sessionId,
          toolName,
          toolCallId,
          semanticHash: buildSideEffectSemanticHash(toolName, params),
          recovering: isCurrentRootTurnRecovering(ctx.sessionId),
        });
        if (claim.kind === 'reuse') {
          return claim.result;
        }
        if (claim.kind === 'block') {
          return toolResult(`[Side-effect repetition blocked] ${claim.message}`, true);
        }
        try {
          const result = await origExecute.call(tool, ...args);
          const saved = await finishSideEffectExecution({
            executionId: claim.executionId,
            ownerToken: claim.ownerToken,
            result,
          });
          if (!saved) {
            return toolResult(`[Side-effect outcome uncertain] ${toolName} completed but its durable result could not be recorded. Automatic repetition is blocked.`, true);
          }
          return result;
        } catch (err) {
          await failSideEffectExecution({
            executionId: claim.executionId,
            ownerToken: claim.ownerToken,
            error: (err as Error)?.message || String(err),
          });
          throw err;
        }
      },
    } as T;
  });
}
