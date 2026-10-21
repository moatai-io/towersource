import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { upsertApiKeyCredential } from '../services/credential-vault/credential-vault-service.js';
import { assertCredentialManagementAccess } from '../services/credential-vault/credential-management-access.js';

const Params = Type.Object({
  value: Type.String({ description: 'Secret value the user explicitly asked the trusted internal Agent to store.' }),
  id: Type.String({ description: 'Stable credential id using lowercase letters, numbers, hyphens, or underscores.' }),
  provider: Type.String({ description: 'Provider such as openai, github, anthropic, or custom.' }),
  displayName: Type.String({ description: 'User-facing Credential name.' }),
  envName: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$', description: 'Environment variable name used when materializing the Credential.' }),
  scope: Type.Optional(Type.Union([
    Type.Literal('project'),
    Type.Literal('workspace'),
  ], { description: 'Defaults to project. workspace requires an explicit team-shared request and admin/operator authority.' })),
  purpose: Type.Optional(Type.String({ description: 'Short allowed-use note stored as non-secret metadata.' })),
  handlingNote: Type.Optional(Type.String({ description: 'Short sensitivity/handling note stored as non-secret metadata.' })),
});

export function createCredentialVaultStoreTool(ctx: { userId?: number; userRole?: string; projectId?: string; channelSafeToolsOnly?: boolean }): ToolDefinition | undefined {
  if (!ctx.userId || !ctx.projectId || ctx.channelSafeToolsOnly) return undefined;
  return {
    name: 'credential_vault_store',
    label: 'Credential Vault Store',
    description: 'Store a secret already supplied in chat into Tower Credential Vault. Available only to trusted internal Agents; the result never returns the secret.',
    promptSnippet: 'Use credential_vault_store only when the user explicitly asked to register or rotate a secret they already supplied in chat. Prefer scope=project. Use scope=workspace only for an explicit team-shared request by an admin/operator. Never repeat the value in chat, logs, files, Git, or reusable artifacts.',
    promptGuidelines: [
      'Do not call this tool merely because a message contains something that looks like a secret. The user must explicitly ask to register, save, connect, or rotate it.',
      'Use credential_vault_input instead when the user has not already supplied the value in chat.',
      'Use scope=project by default. It stores an Agent-dedicated Credential owned by the current Project.',
      'The value is accepted as a tool argument because this is a trusted internal Agent flow. Restricted and externally deployed Agents do not receive this tool.',
      'The tool result contains only non-secret metadata. Do not reproduce the input value after calling it.',
    ],
    parameters: Params,
    async execute(_toolCallId: string, params: any) {
      const scope = params.scope ?? 'project';
      if (scope !== 'project' && scope !== 'workspace') {
        return { content: [{ type: 'text' as const, text: 'Credential storage refused: scope must be project or workspace.' }], details: { stored: false }, isError: true };
      }
      try {
        await assertCredentialManagementAccess({ actorUserId: ctx.userId!, scope: 'project', projectId: ctx.projectId! });
        if (scope === 'workspace') await assertCredentialManagementAccess({ actorUserId: ctx.userId!, scope });
      } catch {
        return { content: [{ type: 'text' as const, text: 'Credential storage refused: current connection management access could not be verified.' }], details: { stored: false, scope }, isError: true };
      }
      const credential = await upsertApiKeyCredential({
        id: String(params.id),
        provider: String(params.provider),
        displayName: String(params.displayName),
        secretName: String(params.envName),
        secretValue: String(params.value),
        defaultEnvName: String(params.envName),
        scope,
        projectId: scope === 'project' ? ctx.projectId! : undefined,
        metadata: {
          source: 'trusted_agent_chat',
          purpose: typeof params.purpose === 'string' ? params.purpose : undefined,
          handling_note: typeof params.handlingNote === 'string' ? params.handlingNote : undefined,
        },
        actorUserId: ctx.userId!,
      });
      return {
        content: [{ type: 'text' as const, text: `Credential ${credential.id} stored in ${scope === 'project' ? 'the current Agent' : 'the team-shared VM Vault'}. The secret value is not included in this result.` }],
        details: { stored: true, credentialId: credential.id, provider: credential.provider, envName: credential.default_env_name, scope: credential.scope },
      };
    },
  } as ToolDefinition;
}
