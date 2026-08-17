// Owns: closure-scoped AI submission of a result to one human approver.
// Public API: createApprovalMcpServer(ctx).

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createApprovalCard } from '../services/approval/approval-card-manager.js';

export interface ApprovalMcpContext {
  sessionId: string;
  userId: number;
  userRole?: string | null;
  projectId?: string | null;
}

const AttachmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('markdown'), label: z.string().max(200).optional(), markdown: z.string().min(1).max(100000) }),
  z.object({ type: z.literal('file'), label: z.string().max(200).optional(), path: z.string().min(1).max(4000) }),
  z.object({ type: z.literal('link'), label: z.string().max(200).optional(), url: z.string().url().max(4000) }),
  z.object({ type: z.literal('session'), label: z.string().max(200).optional(), sessionId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('run'), label: z.string().max(200).optional(), runId: z.string().min(1).max(200) }),
]);

const SUBMIT_DESCRIPTION = [
  'Submit a meaningful completed result to one human as a persistent Tower Approval Card.',
  '',
  'Use only for an accountable handoff: an autonomous result, final artifact review, decision confirmation, or protected action authorization.',
  'Do NOT use for ordinary conversation questions, preference interviews, turn endings, "continue?", or easily reversible choices.',
  'The card appears in My Work and can link Markdown, project files, links, a Session, or an automation Run.',
  'Approval records acceptance/authorization only. It does not prove an external action executed or automatically resume a scheduled Run.',
  'The current Project is the Agent Workspace / Primary AI team member identity anchor. The backend closure supplies requester and Session identity.',
].join('\n');

export function createApprovalMcpServer(ctx: ApprovalMcpContext) {
  return createSdkMcpServer({
    name: 'approval',
    version: '0.1.0',
    tools: [
      tool('submit_for_approval', SUBMIT_DESCRIPTION, {
        approverUserId: z.number().int().positive().describe('One accountable Tower user who must review the submission.'),
        requestType: z.enum(['artifact_review', 'decision', 'action_authorization', 'publication', 'policy_change', 'access_change']).default('artifact_review'),
        title: z.string().min(1).max(300),
        summaryMd: z.string().min(1).max(100000).describe('Decision-ready Markdown summary of the completed result.'),
        recommendationMd: z.string().max(50000).optional(),
        consequenceMd: z.string().min(1).max(50000).describe('Exactly what approval accepts or authorizes; state when no external action occurs.'),
        options: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160) })).max(12).optional(),
        attachments: z.array(AttachmentSchema).max(30).optional(),
        sourceAutomationRunId: z.string().max(200).optional(),
        dueAt: z.string().optional(),
      }, async (args) => {
        try {
          if (!ctx.projectId) return { content: [{ type: 'text' as const, text: 'submit_for_approval denied: an Agent Workspace project is required.' }], isError: true };
          const attachments = [...(args.attachments || [])];
          if (!attachments.some((item) => item.type === 'session')) attachments.push({ type: 'session' as const, sessionId: ctx.sessionId, label: '관련 Session' });
          const card = await createApprovalCard({
            userId: ctx.userId,
            role: ctx.userRole || 'member',
            projectId: ctx.projectId,
            approverUserId: args.approverUserId,
            requestType: args.requestType,
            submitterType: 'workspace_agent',
            title: args.title,
            summaryMd: args.summaryMd,
            recommendationMd: args.recommendationMd,
            consequenceMd: args.consequenceMd,
            options: args.options,
            attachments,
            sourceSessionId: ctx.sessionId,
            sourceAutomationRunId: args.sourceAutomationRunId,
            dueAt: args.dueAt,
          });
          try {
            const { broadcastToUser } = await import('../routes/ws-handler.js');
            broadcastToUser(card.approverUserId, { type: 'approval_card_created', cardId: card.id, projectId: card.projectId });
          } catch {}
          return { content: [{ type: 'text' as const, text: `Submitted Approval Card "${card.title}" to user ${card.approverUserId}. id=${card.id}` }] };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `submit_for_approval failed: ${err?.message || String(err)}` }], isError: true };
        }
      }),
    ],
  });
}
