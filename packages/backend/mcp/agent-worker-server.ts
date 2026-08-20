// agent-worker-server.ts — MCP tools for Agent Control Plane MVP.
// Owns: persistent sibling worker creation, recall, status, lifecycle.
// See: workspace/decisions/2026-06-13-agent-control-plane-unification.md

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { getSession } from '../services/session/session-manager.js';
import {
  archiveWorker,
  createPersistentWorker,
  formatWorkerStatus,
  getWorkerStatus,
  listWorkers,
  pauseWorker,
  resumeWorker,
  sendWorker,
} from '../services/agent-workers.js';
import { MODEL_POLICY_IDS } from '../services/model-policy/model-policy.js';

export interface AgentWorkerMcpContext {
  parentSessionId: string;
  parentUserId: number;
  parentUsername?: string;
  parentRole?: string;
}

async function resolveCallerName(parentSessionId: string): Promise<string> {
  try {
    const s = await getSession(parentSessionId);
    return s?.name || `session ${parentSessionId.slice(0, 8)}`;
  } catch {
    return `session ${parentSessionId.slice(0, 8)}`;
  }
}

const CREATE_DESCRIPTION = [
  'Create a subagent backed by a persistent Tower Agent Session.',
  'Use this when a task benefits from a separate investigator, reviewer, implementer,',
  'or long-lived helper that should keep context and can be recalled later.',
  '',
  'All subagents are persistent Agent Sessions. There is no separate run-once type:',
  'for one-time work, create a subagent with a bounded task and simply do not reuse it.',
  'The worker is registered in Agent Control Plane tables with a state card and run log.',
  '',
  'Report contract: worker runs always report back to the supervisor and wake the parent session when the report is ready.',
  'Persistent worker communication is wake-only; report-only delivery is not exposed on this path.',
  '',
  'Support AI sessions share the same active child-session quota: up to 10 active callbacks per parent session.'
].join('\n');

const SEND_DESCRIPTION = [
  'Send a follow-up task/message to an existing persistent sibling agent.',
  'The agent resumes its backing session and continues with accumulated context.',
  '',
  'Use this instead of creating a new sub-agent when the worker should remember',
  'prior decisions, role, and previous runs.',
  '',
  'Report contract: follow-up runs always report back and wake the supervisor when done.',
  'Persistent worker communication is wake-only; report-only delivery is not exposed on this path.',
].join('\n');

function errText(prefix: string, err: any): string {
  return `${prefix} failed: ${err?.code || ''} ${err?.message || String(err)}`.trim();
}

function sessionDeepLink(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const base = (config.sharePublicUrl || config.publicUrl || '').replace(/\/$/, '');
  return base ? `${base}/s/${sessionId}` : null;
}

export function createAgentWorkerMcpServer(ctx: AgentWorkerMcpContext) {
  return createSdkMcpServer({
    name: 'agent-worker',
    version: '0.1.0',
    tools: [
      tool(
        'persistent_agent_create',
        CREATE_DESCRIPTION,
        {
          name: z.string().min(1).max(80).describe('Human-readable worker name, e.g. "QA steward".'),
          role: z.string().min(1).max(1000).describe('Short role description. What this worker is responsible for.'),
          instruction: z.string().min(1).max(8000).describe('Operating policy for the subagent.'),
          face: z.string().min(1).max(120).optional().describe('Optional emoji or character:<id> identity snapshot shown on cards.'),
          tagline: z.string().min(1).max(300).optional().describe('Optional short identity line shown below the worker name.'),
          goal: z.string().max(1000).optional().describe('Optional goal/state-card goal text. Defaults to role/name.'),
          task: z.string().max(8000).optional().describe('Optional initial task. If omitted, the subagent only bootstraps and reports its operating approach.'),
          visibility: z.enum(['background', 'sidebar', 'team', 'system']).optional().describe('background keeps sidebar clutter low but is still visible via worker list/status.'),
          engine: z.enum(['claude', 'pi']).optional().describe('Engine for backing session. Omit to use server default.'),
          model: z.string().optional().describe('Optional model id for backing session.'),
          model_policy: z.enum(MODEL_POLICY_IDS).optional().describe('Logical workload policy. ultra is reserved and currently disabled.'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Optional explicit reasoning effort override.'),
        },
        async (args) => {
          try {
            const result = await createPersistentWorker({
              parentSessionId: ctx.parentSessionId,
              ownerUserId: ctx.parentUserId,
              parentUsername: ctx.parentUsername,
              parentRole: ctx.parentRole || 'member',
              name: args.name,
              role: args.role,
              instruction: args.instruction,
              face: args.face,
              tagline: args.tagline,
              goal: args.goal,
              task: args.task,
              visibility: args.visibility || 'background',
              engine: args.engine,
              model: args.model,
              modelPolicy: args.model_policy,
              effort: args.effort,
              onComplete: 'wake',
            });
            return {
              content: [{
                type: 'text' as const,
                text:
                  `Created subagent "${args.name}".\n` +
                  `- workerId: ${result.workerId}\n` +
                  `- backingSessionId: ${result.sessionId}\n` +
                  (sessionDeepLink(result.sessionId) ? `- session: ${sessionDeepLink(result.sessionId)}\n` : '') +
                  `- initialRunId: ${result.runId}\n` +
                  `- agentName: ${JSON.stringify(result.name)}\n` +
                  `- agentRole: ${JSON.stringify(result.role)}\n` +
                  (result.face ? `- agentFace: ${JSON.stringify(result.face)}\n` : '') +
                  (result.tagline ? `- agentTagline: ${JSON.stringify(result.tagline)}\n` : '') +
                  `- mode: wake\n` +
                  `Reports default to wake/report-and-resume; use status only when you need extra detail.`,
              }],
            };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: errText('persistent_agent_create', err) }], isError: true };
          }
        },
      ),
      tool(
        'persistent_agent_send',
        SEND_DESCRIPTION,
        {
          worker: z.string().min(1).describe('Worker id, backing session id, id prefix, or exact worker name.'),
          message: z.string().min(1).describe('Follow-up task/message to send to the persistent agent.'),
        },
        async (args) => {
          try {
            const callerName = await resolveCallerName(ctx.parentSessionId);
            const result = await sendWorker({
              callerSessionId: ctx.parentSessionId,
              callerSessionName: callerName,
              callerUserId: ctx.parentUserId,
              callerRole: ctx.parentRole || 'member',
              workerIdOrName: args.worker,
              message: args.message,
              onComplete: 'wake',
            });
            return {
              content: [{
                type: 'text' as const,
                text:
                  `Sent to persistent agent ${result.workerId.slice(0, 8)}.\n` +
                  `- backingSessionId: ${result.sessionId}\n` +
                  (sessionDeepLink(result.sessionId) ? `- session: ${sessionDeepLink(result.sessionId)}\n` : '') +
                  `- runId: ${result.runId}\n` +
                  `- agentName: ${JSON.stringify(result.name)}\n` +
                  `- agentRole: ${JSON.stringify(result.role)}\n` +
                  (result.face ? `- agentFace: ${JSON.stringify(result.face)}\n` : '') +
                  (result.tagline ? `- agentTagline: ${JSON.stringify(result.tagline)}\n` : '') +
                  `- mode: wake`,
              }],
            };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: errText('persistent_agent_send', err) }], isError: true };
          }
        },
      ),
      tool(
        'persistent_agent_status',
        'Get status, state card, latest run, and last response preview for a persistent agent.',
        {
          worker: z.string().min(1).describe('Worker id, backing session id, id prefix, or exact worker name.'),
        },
        async (args) => {
          try {
            const info = await getWorkerStatus(ctx.parentUserId, ctx.parentSessionId, args.worker);
            return { content: [{ type: 'text' as const, text: formatWorkerStatus(info) }] };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: errText('persistent_agent_status', err) }], isError: true };
          }
        },
      ),
      tool(
        'persistent_agent_list',
        'List persistent sibling agents available to this user/session.',
        {
          include_archived: z.boolean().optional().describe('Include archived workers. Default false.'),
          limit: z.number().int().min(1).max(100).optional().describe('Max workers to list. Default 20.'),
        },
        async (args) => {
          try {
            const parent = await getSession(ctx.parentSessionId);
            const workers = await listWorkers({
              ownerUserId: ctx.parentUserId,
              parentSessionId: ctx.parentSessionId,
              projectId: parent?.projectId ?? undefined,
              includeArchived: args.include_archived || false,
              limit: args.limit || 20,
            });
            if (workers.length === 0) {
              return { content: [{ type: 'text' as const, text: 'No persistent agents yet.' }] };
            }
            const lines = workers.map((info) => {
              const w = info.worker;
              const card = info.stateCard;
              return [
                `- ${w.id.slice(0, 8)} [${info.runtimeStatus}] "${w.name}"`,
                `  role: ${w.role || '(none)'}`,
                `  backing: ${w.backing_session_id ? w.backing_session_id.slice(0, 8) : '(none)'}`,
                sessionDeepLink(w.backing_session_id) ? `  session: ${sessionDeepLink(w.backing_session_id)}` : undefined,
                card?.next_action ? `  next: ${card.next_action}` : undefined,
              ].filter(Boolean).join('\n');
            });
            return { content: [{ type: 'text' as const, text: `Persistent agents (${workers.length}):\n${lines.join('\n')}` }] };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: errText('persistent_agent_list', err) }], isError: true };
          }
        },
      ),
      tool(
        'persistent_agent_pause',
        'Pause a persistent agent. Paused workers refuse follow-up sends until resumed.',
        { worker: z.string().min(1).describe('Worker id, backing session id, id prefix, or exact worker name.') },
        async (args) => {
          try {
            const worker = await pauseWorker(ctx.parentUserId, ctx.parentSessionId, args.worker);
            return { content: [{ type: 'text' as const, text: `Paused ${worker.name} (${worker.id}).` }] };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: errText('persistent_agent_pause', err) }], isError: true };
          }
        },
      ),
      tool(
        'persistent_agent_resume',
        'Resume a paused persistent agent.',
        { worker: z.string().min(1).describe('Worker id, backing session id, id prefix, or exact worker name.') },
        async (args) => {
          try {
            const worker = await resumeWorker(ctx.parentUserId, ctx.parentSessionId, args.worker);
            return { content: [{ type: 'text' as const, text: `Resumed ${worker.name} (${worker.id}).` }] };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: errText('persistent_agent_resume', err) }], isError: true };
          }
        },
      ),
      tool(
        'persistent_agent_archive',
        'Archive a persistent agent registry entry. The backing session is preserved.',
        { worker: z.string().min(1).describe('Worker id, backing session id, id prefix, or exact worker name.') },
        async (args) => {
          try {
            const worker = await archiveWorker(ctx.parentUserId, ctx.parentSessionId, args.worker);
            return { content: [{ type: 'text' as const, text: `Archived ${worker.name} (${worker.id}). Backing session preserved.` }] };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: errText('persistent_agent_archive', err) }], isError: true };
          }
        },
      ),
    ],
  });
}
