import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { scheduleWait, MAX_WAIT_SECONDS, WAIT_DESCRIPTION } from '../services/agent-sleep/alarms.js';

export function createSleepTool(ctx: { sessionId: string; rootTurnId?: string }): ToolDefinition {
  return {
    executionMode: 'sequential',
    name: 'wait', label: '잠시 기다리기', description: WAIT_DESCRIPTION,
    parameters: Type.Object({
      durationSeconds: Type.Integer({ minimum: 1, maximum: MAX_WAIT_SECONDS }),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    async execute(_id, params, signal) {
      const result = await scheduleWait(params as {durationSeconds:number;reason:string}, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
