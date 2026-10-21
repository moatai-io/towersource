import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MAX_WAIT_SECONDS, WAIT_DESCRIPTION } from '../services/agent-sleep/alarms.js';

export function createSleepMcpServer(ctx: { sessionId: string; rootTurnId?: string; getSignal?(): AbortSignal | undefined }) {
  return createSdkMcpServer({ name: 'wait', version: '1.0.0', tools: [
    tool('wait', WAIT_DESCRIPTION, {
      durationSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS),
      reason: z.string().trim().min(1).max(500),
    }, async (params, extra) => {
      try {
        throw new Error('Stored wait alarms currently require the Pi engine. No alarm was created.');
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    }),
  ] });
}
