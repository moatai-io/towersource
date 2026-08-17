/**
 * session-control-server.ts — Thin in-process MCP controls for the current Tower session.
 *
 * Owns: safe, narrow session metadata primitives for AI runtimes.
 * Public API: createSessionControlMcpServer(ctx).
 *
 * Design: thick skills decide *when/why/what to propose*; this server only
 * executes a user-approved primitive against the closure-bound current session.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { canAccessSession } from '../services/pm/project-access.js';
import { updateSession } from '../services/session/session-manager.js';

export interface SessionControlMcpContext {
  sessionId: string;
  userId: number;
  userRole?: string;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RENAME_CURRENT_SESSION_DESCRIPTION = [
  'Rename the CURRENT Tower session in the sidebar.',
  '',
  'Use ONLY after the user has agreed to the proposed session title, or when an active skill explicitly instructs you to rename after user confirmation.',
  'Do not call this silently or just because you personally think a better title exists.',
  '',
  'This tool is intentionally narrow: it can only rename the current session captured by the runtime. It cannot rename arbitrary sessions.',
].join('\n');

/**
 * Mount once per AI run. ctx.sessionId/userId are closure-captured so the model
 * cannot forge a different target session or actor.
 */
export function createSessionControlMcpServer(ctx: SessionControlMcpContext) {
  return createSdkMcpServer({
    name: 'session-control',
    version: '0.1.0',
    tools: [
      tool(
        'rename_current_session',
        RENAME_CURRENT_SESSION_DESCRIPTION,
        {
          title: z
            .string()
            .min(2)
            .max(80)
            .describe('New sidebar title for the current session. Keep it concise and specific.'),
        },
        async (args) => {
          try {
            const title = cleanTitle(args.title);
            if (title.length < 2) {
              return {
                content: [{ type: 'text' as const, text: 'rename_current_session failed: title is too short after trimming.' }],
                isError: true,
              };
            }
            if (title.length > 80) {
              return {
                content: [{ type: 'text' as const, text: 'rename_current_session failed: title must be 80 characters or less.' }],
                isError: true,
              };
            }

            const access = await canAccessSession(ctx.sessionId, ctx.userId, ctx.userRole || 'member');
            if (!access.allowed) {
              return {
                content: [{ type: 'text' as const, text: `rename_current_session denied: ${access.message}` }],
                isError: true,
              };
            }

            await updateSession(ctx.sessionId, { name: title, autoNamed: 0 } as any);

            try {
              const { broadcastToAll } = await import('../routes/ws-handler.js');
              broadcastToAll({
                type: 'session_meta_update',
                sessionId: ctx.sessionId,
                updates: { name: title, autoNamed: 0 },
              });
            } catch (err: any) {
              console.warn('[session-control] broadcast failed:', err?.message || err);
            }

            console.log(`[session-control] renamed current session=${ctx.sessionId.slice(0, 8)} title="${title}"`);
            return {
              content: [{ type: 'text' as const, text: `Renamed current session to "${title}".` }],
            };
          } catch (err: any) {
            return {
              content: [{ type: 'text' as const, text: `rename_current_session failed: ${err?.message || String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
