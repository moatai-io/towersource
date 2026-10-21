import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { copyProjectCredential, revealCredentialValue } from '../services/credential-vault/credential-vault-service.js';
import { assertCredentialManagementAccess } from '../services/credential-vault/credential-management-access.js';

const Params = Type.Object({
  action: Type.Union([Type.Literal('reveal'), Type.Literal('import')]),
  credentialId: Type.String({ description: 'Credential id to reveal, or source Credential id to import.' }),
  purpose: Type.Optional(Type.String({ description: 'Short reason for an audited reveal.' })),
  sourceProjectId: Type.Optional(Type.String({ description: 'Accessible source Project id for import.' })),
});

export function createCredentialVaultAccessTool(ctx: { userId?: number; userRole?: string; projectId?: string; channelSafeToolsOnly?: boolean }): ToolDefinition | undefined {
  if (!ctx.userId || !ctx.projectId || ctx.channelSafeToolsOnly) return undefined;
  return {
    name: 'credential_vault_access',
    label: 'Credential Vault Access',
    description: 'Reveal a Credential available to the current trusted internal Agent, or copy a Credential from another Project whose connections the user can manage into this Agent.',
    promptSnippet: 'Use credential_vault_access only when the user explicitly asks to inspect a Credential value or import one from another Agent whose connections the user can manage. Do not repeat revealed values in chat unless the user explicitly asks to see the value. Never write revealed values to Git, logs, or reusable artifacts.',
    parameters: Params,
    async execute(_toolCallId: string, params: any) {
      try {
        await assertCredentialManagementAccess({ actorUserId: ctx.userId!, scope: 'project', projectId: ctx.projectId! });
      } catch {
        return { content: [{ type: 'text' as const, text: 'Credential access refused: current Agent management access could not be verified.' }], details: { refused: true }, isError: true };
      }
      if (params.action !== 'reveal' && params.action !== 'import') return { content: [{ type: 'text' as const, text: 'Credential access refused: unsupported action.' }], isError: true };
      if (params.action === 'reveal') {
        const result = await revealCredentialValue({ projectId: ctx.projectId!, credentialId: String(params.credentialId), actorUserId: ctx.userId!, purpose: String(params.purpose || 'Trusted Agent self-healing') });
        return { content: [{ type: 'text' as const, text: `Credential ${result.credential.id} revealed for the current trusted Agent. Treat the following as secret and do not repeat it unless explicitly requested:\n${result.value}` }], details: { action: 'reveal', credentialId: result.credential.id } };
      }
      const sourceProjectId = String(params.sourceProjectId || '');
      if (!sourceProjectId) return { content: [{ type: 'text' as const, text: 'Credential import refused: sourceProjectId is required.' }], details: { action: 'import', refused: true }, isError: true };
      try {
        await assertCredentialManagementAccess({ actorUserId: ctx.userId!, scope: 'project', projectId: sourceProjectId });
      } catch {
        return { content: [{ type: 'text' as const, text: 'Credential import refused: source Agent connection management access could not be verified.' }], details: { action: 'import', refused: true }, isError: true };
      }
      const copied = await copyProjectCredential({ sourceProjectId, sourceCredentialId: String(params.credentialId), targetProjectId: ctx.projectId!, actorUserId: ctx.userId! });
      return { content: [{ type: 'text' as const, text: `Credential imported as ${copied.id} for the current Agent. The secret value was copied internally and was not printed.` }], details: { action: 'import', credentialId: copied.id } };
    },
  } as ToolDefinition;
}
