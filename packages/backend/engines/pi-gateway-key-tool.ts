import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { issueOrRotateZuploKeyAndStore } from '../services/gateway-profile/zuplo-key-issuance.js';

const Params = Type.Object({
  operation: Type.Union([Type.Literal('issue'), Type.Literal('rotate')]),
  account: Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9._-]+$' }),
  bucketId: Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9._-]+$' }),
  consumerName: Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9._-]+$' }),
  consumerDescription: Type.Optional(Type.String({ maxLength: 500 })),
  consumerMetadata: Type.Optional(Type.Record(Type.String({ maxLength: 80 }), Type.String({ maxLength: 500 }))),
  consumerTags: Type.Optional(Type.Record(Type.String({ maxLength: 80 }), Type.String({ maxLength: 200 }))),
  expiresOn: Type.Optional(Type.String({ maxLength: 80, description: 'Required for rotate. ISO timestamp when the old key should expire.' })),
  credentialId: Type.String({ minLength: 2, maxLength: 80, pattern: '^[a-z0-9][a-z0-9_-]+$' }),
  credentialEnvName: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' }),
  credentialDisplayName: Type.String({ minLength: 1, maxLength: 160 }),
  confirmed: Type.Literal(true, { description: 'True only after the user explicitly approved this exact consumer, bucket, operation, expiry, and Vault destination.' }),
}, { additionalProperties: false });

function safeError(error: unknown): { code: string; message: string } {
  const value = error as { code?: string };
  return {
    code: value?.code ?? 'GATEWAY_KEY_ISSUE_AND_STORE_FAILED',
    message: value?.code === 'ZUPLO_KEY_VAULT_STORE_FAILED'
      ? 'Gateway key issuance requires recovery because Vault storage did not complete.'
      : error instanceof Error ? error.message : 'Gateway key issuance failed.',
  };
}

export function createGatewayKeyIssueAndStoreTool(ctx: {
  userId?: number;
  userRole?: string;
  projectId?: string;
  channelSafeToolsOnly?: boolean;
}): ToolDefinition | undefined {
  if (!ctx.userId || !ctx.projectId || !['admin', 'operator'].includes(ctx.userRole ?? '') || ctx.channelSafeToolsOnly) return undefined;
  return {
    name: 'gateway_key_issue_and_store',
    label: 'Gateway Key Issue and Store',
    description: 'Issue or rotate one Zuplo virtual key and store it directly in Tower Credential Vault. The key value never enters chat, model context, tool arguments, or tool results.',
    promptSnippet: 'Use gateway_key_issue_and_store only after showing the exact Zuplo consumer, bucket, operation, old-key expiry for rotation, and team-shared Vault destination, then receiving explicit approval. Never use bash/curl to issue a virtual key.',
    promptGuidelines: [
      'This tool is for issue and rotate only. Listing is read-only; revoke remains a separately approved destructive path.',
      'The destination is team-shared because Gateway Profile virtual keys are VM-level infrastructure credentials. Current workspace Credential authority is checked server-side.',
      'If Vault storage fails after provider issuance, stop and report recovery_required. Do not retry because a second issue/rotate could create another key.',
      'The result is a secret-free receipt containing identifiers only.',
    ],
    parameters: Params,
    async execute(_toolCallId, params: any, signal) {
      try {
        const receipt = await issueOrRotateZuploKeyAndStore({
          operation: params.operation,
          actorUserId: ctx.userId!,
          projectId: ctx.projectId!,
          account: params.account,
          bucketId: params.bucketId,
          consumerName: params.consumerName,
          consumerDescription: params.consumerDescription,
          consumerMetadata: params.consumerMetadata,
          consumerTags: params.consumerTags,
          expiresOn: params.expiresOn,
          credentialId: params.credentialId,
          credentialEnvName: params.credentialEnvName,
          credentialDisplayName: params.credentialDisplayName,
          confirmed: params.confirmed,
          signal,
        });
        return {
          content: [{ type: 'text' as const, text: `Gateway key ${receipt.operation} completed and stored in Credential Vault. consumer=${receipt.consumerName}, keyId=${receipt.keyId}, credentialId=${receipt.credentialId}. The key value is not included.` }],
          details: receipt,
        };
      } catch (error) {
        const safe = safeError(error);
        return {
          content: [{ type: 'text' as const, text: `Gateway key operation failed: ${safe.message}` }],
          details: { stored: false, code: safe.code, recoveryRequired: safe.code === 'ZUPLO_KEY_VAULT_STORE_FAILED' },
          isError: true,
        };
      }
    },
  } as ToolDefinition;
}
