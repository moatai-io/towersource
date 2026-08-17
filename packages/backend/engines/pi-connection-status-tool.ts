import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { diagnoseProjectConnectionStatus } from '../services/credential-vault/connection-reliability.js';

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: undefined };
}

export function createConnectionStatusTool(ctx: { userId?: number; projectId?: string }): ToolDefinition | null {
  if (!ctx.userId || !ctx.projectId) return null;
  return {
    name: 'connection_status',
    label: 'Connection Status',
    description: 'Check known provider Connections and all Agent-bound project Credentials. Returns secret-free inventory, access, materialization, and provider-verification stages; never returns Credential values or environment names.',
    promptSnippet: 'When a provider tool or skill reports a missing/changed credential, call connection_status before asking the user for a key. A missing item is a lookup result, not proof that saving failed. Use inventoryComplete, stoppedAt, and nextAction; verify Runtime materialization before suggesting re-entry.',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => result({ projectId: ctx.projectId, ...await diagnoseProjectConnectionStatus({ projectId: ctx.projectId!, userId: ctx.userId! }) }),
  } as ToolDefinition;
}
