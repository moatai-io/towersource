/**
 * schedule-server.ts — in-process MCP bridge for Tower automation control.
 *
 * Owns: user/project-bound primitives that let AI create and operate
 *   automations without seeing API tokens or browser credentials.
 * Public API: createScheduleMcpServer(ctx).
 *
 * Design: task-schedule skill gathers intent and user confirmation; this server
 *   executes only the final creation against closure-bound Tower identity.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  createAutomation,
  getAutomationRuns,
  type Automation,
  type CronConfig,
} from '../services/task/automation-manager.js';
import { canCreateAutomationJob } from '../services/task/schedule-permissions.js';
import {
  type AutomationControlActor,
  archiveAutomationJob,
  requireAutomationCapability,
  runAutomationNow,
  setAutomationEnabled,
} from '../services/task/automation-control.js';
import {
  applyAutomationChangeIntent,
  createAutomationChangeIntent,
} from '../services/task/automation-change-intent.js';
import {
  listScheduleInventory,
  setLegacyScheduledTaskEnabled,
} from '../services/task/schedule-inventory.js';

export interface ScheduleMcpContext {
  sessionId: string;
  userId: number;
  userRole?: string | null;
  projectId?: string | null;
  cwd?: string | null;
}

const CronConfigSchema = z.union([
  z.object({
    type: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    type: z.literal('weekdays'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    type: z.literal('weekly'),
    day: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    type: z.literal('interval'),
    minutes: z.number().int().min(1).max(10080),
  }),
]);

const CREATE_AI_SCHEDULE_DESCRIPTION = [
  'Create a Tower schedule/automation for the CURRENT user/session context.',
  '',
  'Use for low-risk AI prompt schedules such as daily/weekly reminders, summaries, or briefings.',
  'Use ONLY after the user has confirmed the schedule summary. Do not create silently.',
  '',
  'The Tower backend closure supplies userId, role, projectId, cwd, and sessionId. Do not ask for API tokens.',
  'This tool does not create shell/script/webhook jobs; those require a separate higher-risk flow.',
].join('\n');

function isPrivileged(role?: string | null): boolean {
  return role === 'admin' || role === 'operator';
}

function summarizeSchedule(triggerType: string, cronConfig?: CronConfig, onceAt?: string): string {
  if (triggerType === 'once') return onceAt ? `once at ${onceAt}` : 'once';
  if (triggerType !== 'cron' || !cronConfig) return 'manual';
  switch ((cronConfig as any).type) {
    case 'daily': return `daily at ${String((cronConfig as any).hour).padStart(2, '0')}:${String((cronConfig as any).minute).padStart(2, '0')}`;
    case 'weekdays': return `weekdays at ${String((cronConfig as any).hour).padStart(2, '0')}:${String((cronConfig as any).minute).padStart(2, '0')}`;
    case 'weekly': return `weekly day ${(cronConfig as any).day} at ${String((cronConfig as any).hour).padStart(2, '0')}:${String((cronConfig as any).minute).padStart(2, '0')}`;
    case 'interval': return `every ${(cronConfig as any).minutes} minutes`;
    default: return 'cron';
  }
}

function compactAutomation(automation: Automation) {
  return {
    id: automation.id,
    name: automation.name,
    description: automation.description,
    projectId: automation.projectId,
    jobType: automation.jobType,
    triggerType: automation.triggerType,
    enabled: automation.enabled,
    status: automation.status,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    lastStatus: automation.lastStatus,
    lastError: automation.lastError,
    runCount: automation.runCount,
    createdBySessionId: automation.createdBySessionId,
  };
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(action: string, message: string) {
  return { content: [{ type: 'text' as const, text: `${action} failed: ${message}` }], isError: true };
}

export function createScheduleMcpServer(ctx: ScheduleMcpContext) {
  // Adapt the trusted session identity; MCP context uses userRole, control uses role.
  const actor: AutomationControlActor = { userId: ctx.userId, role: ctx.userRole };
  return createSdkMcpServer({
    name: 'schedule',
    version: '0.1.0',
    tools: [
      tool(
        'create_ai_schedule',
        CREATE_AI_SCHEDULE_DESCRIPTION,
        {
          name: z.string().min(1).max(120).describe('User-facing schedule name.'),
          description: z.string().min(1).max(1000).describe('Short purpose/expected result in user language.'),
          prompt: z.string().min(1).max(8000).describe('Prompt the scheduled AI job should run.'),
          triggerType: z.enum(['cron', 'once', 'manual']).default('cron').describe('When to run the job.'),
          cronConfig: CronConfigSchema.optional().describe('Required when triggerType is cron.'),
          onceAt: z.string().optional().describe('ISO datetime for one-time schedules.'),
          projectId: z.string().uuid().optional().describe('Optional override. Defaults to the current session project.'),
          timezone: z.string().optional().describe('IANA timezone. Defaults to Asia/Seoul.'),
          resultTarget: z.string().max(500).optional().describe('Plain-language place to leave results, e.g. current project/session.'),
        },
        async (args) => {
          try {
            const triggerType = args.triggerType || 'cron';
            if (triggerType === 'cron' && !args.cronConfig) {
              return { content: [{ type: 'text' as const, text: 'create_ai_schedule failed: cronConfig is required for recurring schedules.' }], isError: true };
            }
            if (triggerType === 'once' && !args.onceAt) {
              return { content: [{ type: 'text' as const, text: 'create_ai_schedule failed: onceAt is required for one-time schedules.' }], isError: true };
            }

            const projectId = args.projectId || ctx.projectId || undefined;
            if (!projectId && !isPrivileged(ctx.userRole)) {
              return { content: [{ type: 'text' as const, text: 'create_ai_schedule denied: a current project is required.' }], isError: true };
            }

            const definitionJson = {
              description: args.description,
              prompt: args.prompt,
              resultTarget: args.resultTarget || null,
              source: 'schedule-mcp',
            };

            const access = await canCreateAutomationJob({
              userId: ctx.userId,
              role: ctx.userRole,
              projectId,
              jobType: 'ai_prompt',
              scopeType: projectId ? 'project' : 'system',
              definitionJson,
            });
            if (!access.allowed) {
              return { content: [{ type: 'text' as const, text: `create_ai_schedule denied: ${access.message || 'forbidden'}` }], isError: true };
            }

            const automation = await createAutomation({
              userId: ctx.userId,
              projectId,
              name: args.name,
              description: args.description,
              prompt: args.prompt,
              jobType: 'ai_prompt',
              scopeType: projectId ? 'project' : 'system',
              definitionJson,
              triggerType,
              cronConfig: args.cronConfig as CronConfig | undefined,
              onceAt: args.onceAt,
              timezone: args.timezone || 'Asia/Seoul',
              createdBySessionId: ctx.sessionId,
              cwd: ctx.cwd || undefined,
            });

            try {
              const { broadcastToAll } = await import('../routes/ws-handler.js');
              broadcastToAll({ type: 'automation_created', automation });
            } catch (err: any) {
              console.warn('[schedule-mcp] broadcast failed:', err?.message || err);
            }

            console.log(`[schedule-mcp] created automation=${automation.id.slice(0, 8)} user=${ctx.userId} project=${projectId || 'system'} name="${args.name}"`);
            return {
              content: [{
                type: 'text' as const,
                text: `Created schedule "${automation.name}" (${summarizeSchedule(triggerType, args.cronConfig as CronConfig | undefined, args.onceAt)}). id=${automation.id}`,
              }],
            };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `create_ai_schedule failed: ${err?.message || String(err)}` }], isError: true };
          }
        },
      ),
      tool(
        'list_automations',
        [
          'List Tower automations visible to the CURRENT user in the closure-bound project context.',
          'Use to inspect status, next run, recent failure, and ownership before proposing or performing control actions.',
          'This is read-only.',
        ].join('\n'),
        {
          projectId: z.string().uuid().optional().describe('Optional project filter. Defaults to the current session project.'),
          includeArchived: z.boolean().optional().describe('Include archived automations. Default false.'),
        },
        async (args) => {
          try {
            const projectId = args.projectId || ctx.projectId || undefined;
            const inventory = await listScheduleInventory({
              userId: ctx.userId,
              role: ctx.userRole,
              projectId,
              includeArchived: args.includeArchived || false,
            });
            return textResult(inventory);
          } catch (err: any) {
            return errorResult('list_automations', err?.message || String(err));
          }
        },
      ),
      tool(
        'set_legacy_schedule_enabled',
        [
          'Enable or disable one legacy Tower scheduled task owned by the CURRENT user.',
          'Use ONLY after list_automations returns source="legacy_task" and the user explicitly confirms this exact change.',
          'This is a compatibility control while legacy tasks are migrated to the Automation registry.',
        ].join('\n'),
        {
          taskId: z.string().min(1),
          enabled: z.boolean(),
          confirmed: z.literal(true).describe('Must be true only after explicit user confirmation.'),
        },
        async (args) => {
          try {
            const changed = await setLegacyScheduledTaskEnabled({
              id: args.taskId,
              enabled: args.enabled,
              userId: ctx.userId,
              role: ctx.userRole,
            });
            if (!changed) return errorResult('set_legacy_schedule_enabled', 'not found');
            return textResult({ ok: true, source: 'legacy_task', id: args.taskId, enabled: args.enabled });
          } catch (err: any) {
            return errorResult('set_legacy_schedule_enabled', err?.message || String(err));
          }
        },
      ),
      tool(
        'get_automation',
        'Get one Tower automation and its current status. Read-only and closure-authorized.',
        { automationId: z.string().uuid() },
        async (args) => {
          try {
            const { automation, access } = await requireAutomationCapability(args.automationId, actor, 'read');
            if (!access.allowed || !automation) return errorResult('get_automation', access.message || 'forbidden');
            return textResult(compactAutomation(automation));
          } catch (err: any) {
            return errorResult('get_automation', err?.message || String(err));
          }
        },
      ),
      tool(
        'get_automation_runs',
        'Read recent execution history for one Tower automation. Read-only and closure-authorized.',
        {
          automationId: z.string().uuid(),
          limit: z.number().int().min(1).max(50).optional(),
        },
        async (args) => {
          try {
            const { automation, access } = await requireAutomationCapability(args.automationId, actor, 'read');
            if (!access.allowed || !automation) return errorResult('get_automation_runs', access.message || 'forbidden');
            return textResult(await getAutomationRuns(automation.id, args.limit || 10));
          } catch (err: any) {
            return errorResult('get_automation_runs', err?.message || String(err));
          }
        },
      ),
      tool(
        'propose_automation_change',
        [
          'Create a short-lived, server-stored preview intent for an automation YAML change.',
          'Project members may propose; this does not mutate the automation.',
          'Return the proposalHash, risk, warnings, and expiry for human review before apply.',
        ].join('\n'),
        {
          automationId: z.string().uuid(),
          yaml: z.string().min(1).max(100_000),
          summary: z.string().max(1000).optional(),
        },
        async (args) => {
          try {
            const { automation, access } = await requireAutomationCapability(args.automationId, actor, 'propose');
            if (!access.allowed || !automation) return errorResult('propose_automation_change', access.message || 'forbidden');
            return textResult(await createAutomationChangeIntent({
              automation,
              actorUserId: ctx.userId,
              actorRole: ctx.userRole,
              sourceSessionId: ctx.sessionId,
              yaml: args.yaml,
              summary: args.summary || null,
            }));
          } catch (err: any) {
            return errorResult('propose_automation_change', err?.message || String(err));
          }
        },
      ),
      tool(
        'apply_automation_change',
        [
          'Apply one exact server-stored automation change intent after the user reviews its proposalHash, risk, warnings, and impact.',
          'Use ONLY after the user explicitly confirms approval of this exact intent and hash.',
          'The server rejects expired, stale, changed, unauthorized, or already-consumed intents.',
        ].join('\n'),
        {
          automationId: z.string().uuid(),
          intentId: z.string().uuid(),
          proposalHash: z.string().length(64),
          confirmed: z.literal(true),
          confirmedHighRisk: z.boolean().optional().describe('Must be true when the preview risk is high and the user explicitly approved that risk.'),
        },
        async (args) => {
          try {
            return textResult(await applyAutomationChangeIntent({
              intentId: args.intentId,
              automationId: args.automationId,
              actorUserId: ctx.userId,
              actorRole: ctx.userRole,
              proposalHash: args.proposalHash,
              confirmedHighRisk: args.confirmedHighRisk === true,
            }));
          } catch (err: any) {
            return errorResult('apply_automation_change', err?.message || String(err));
          }
        },
      ),
      tool(
        'set_automation_enabled',
        [
          'Enable or disable one Tower automation owned by the CURRENT user.',
          'Use ONLY after the user explicitly confirms this exact enable/disable change.',
          'Project visibility alone does not grant control; owner/operator capability is enforced server-side.',
        ].join('\n'),
        {
          automationId: z.string().uuid(),
          enabled: z.boolean(),
          confirmed: z.literal(true).describe('Must be true only after explicit user confirmation.'),
        },
        async (args) => {
          try {
            const { automation, access } = await requireAutomationCapability(args.automationId, actor, 'edit');
            if (!access.allowed || !automation) return errorResult('set_automation_enabled', access.message || 'forbidden');
            const updated = await setAutomationEnabled(automation, args.enabled, ctx.userId);
            return textResult({ ok: true, automation: updated ? compactAutomation(updated) : null });
          } catch (err: any) {
            return errorResult('set_automation_enabled', err?.message || String(err));
          }
        },
      ),
      tool(
        'run_automation_now',
        [
          'Run one Tower automation now under the CURRENT closure-bound user authority.',
          'Use ONLY after the user explicitly confirms this exact run.',
          'The run uses the same audit log and Process Map path as the REST Run Now action.',
        ].join('\n'),
        {
          automationId: z.string().uuid(),
          confirmed: z.literal(true).describe('Must be true only after explicit user confirmation.'),
        },
        async (args) => {
          try {
            const { automation, access } = await requireAutomationCapability(args.automationId, actor, 'run');
            if (!access.allowed || !automation) return errorResult('run_automation_now', access.message || 'forbidden');
            const { broadcastToAll } = await import('../routes/ws-handler.js');
            const result = await runAutomationNow({
              automation,
              broadcast: (type, payload) => broadcastToAll({ type, ...payload }),
            });
            return textResult(result);
          } catch (err: any) {
            return errorResult('run_automation_now', err?.message || String(err));
          }
        },
      ),
      tool(
        'archive_automation',
        [
          'Soft-archive one Tower automation owned by the CURRENT user. The record remains recoverable.',
          'Use ONLY after the user explicitly confirms archiving this exact automation.',
        ].join('\n'),
        {
          automationId: z.string().uuid(),
          confirmed: z.literal(true).describe('Must be true only after explicit user confirmation.'),
        },
        async (args) => {
          try {
            const { automation, access } = await requireAutomationCapability(args.automationId, actor, 'archive');
            if (!access.allowed || !automation) return errorResult('archive_automation', access.message || 'forbidden');
            return textResult({ ok: await archiveAutomationJob(automation), automationId: automation.id, archived: true });
          } catch (err: any) {
            return errorResult('archive_automation', err?.message || String(err));
          }
        },
      ),
    ],
  });
}
