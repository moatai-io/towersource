import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { assertCredentialManagementAccess } from '../services/credential-vault/credential-management-access.js';

const Params = Type.Object({
  inputType: Type.Optional(Type.Union([Type.Literal('value'), Type.Literal('fields'), Type.Literal('json')], { description: 'Secure input shape. Default value.' })),
  id: Type.String({ description: 'Stable credential id, lowercase letters/numbers/hyphens.' }),
  provider: Type.String({ description: 'Provider such as openai, github, custom.' }),
  displayName: Type.String({ description: 'User-facing credential name.' }),
  envName: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$', description: 'Environment variable name for value/json input.' })),
  fields: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' }),
    label: Type.Optional(Type.String()),
    required: Type.Optional(Type.Boolean()),
  }), { description: 'Environment fields for inputType=fields.' })),
  scope: Type.Optional(Type.Union([
    Type.Literal('project'),
    Type.Literal('workspace'),
  ], { description: 'project means the current Agent only. workspace means team-shared and is automatically available to every Project.' })),
  purpose: Type.Optional(Type.String({ description: 'Short allowed-use note stored as metadata.' })),
  handlingNote: Type.Optional(Type.String({ description: 'Short sensitivity/handling note stored as metadata.' })),
});

export function createCredentialVaultInputTool(ctx: { userId?: number; userRole?: string; projectId?: string }): ToolDefinition {
  return {
    name: 'credential_vault_input',
    label: 'Credential Vault Input',
    description: 'Open a secure password field that saves a credential directly to Tower Credential Vault. The secret never enters chat or AI context.',
    promptSnippet: 'Use credential_vault_input for API keys, passwords, login credentials, tokens, or other env-style secrets after the user asks to register or rotate one, or accepts an offer to open a secure input. Never request the value in chat.',
    promptGuidelines: [
      'Never ask the user to paste a secret into chat. If a workflow discovers a missing credential, offer to open a secure input (for example, “안전 입력창을 열어드릴까요?”) and wait for consent instead of directing the user to Credential Vault or opening it without notice. If the user already explicitly asked to register or rotate the credential, that request is sufficient consent to open it.',
      'Use it for operational credentials such as API keys, account passwords, login pairs, tokens, private keys, and validated credential JSON. It is not a general-purpose store for identity documents, financial records, medical information, or arbitrary private notes.',
      'Use scope=project by default. It creates an Agent-dedicated Credential whose project_id is the current Agent Project.',
      'Use scope=workspace only when an admin/operator explicitly requests a team-shared Credential. Workspace Credentials are automatically available to every ordinary Project; there is no separate grant or policy step.',
      'Use inputType=value for one secret, fields for multiple environment secrets, and json for a validated JSON document.',
      'For fields, provide each environment variable in fields; envName is not required. For value/json, envName is required. Exception: provider=google with inputType=json creates a Project Google Connection and does not use an envName.',
      'This tool requests secure input UI; it does not confirm browser display or saving and does not receive or return the secret value. After explicit consent, call the tool without asking again. Never claim the credential is saved based on this result.',
      'If the credential id already exists with the same provider/env/scope and Agent owner, saving rotates its value. Conflicting metadata is rejected safely.',
    ],
    parameters: Params,
    async execute(_toolCallId: string, params: any) {
      const scope = params.scope || 'project';
      const inputType = params.inputType || 'value';
      const googleJson = inputType === 'json' && params.provider === 'google';
      if (inputType === 'fields' ? !params.fields?.length : (!params.envName && !googleJson)) {
        return { isError: true, content: [{ type: 'text' as const, text: `Credential Vault input refused: ${inputType === 'fields' ? 'fields' : 'envName'} is required.` }] };
      }
      if (googleJson && scope !== 'project') {
        return { isError: true, content: [{ type: 'text' as const, text: 'Credential Vault input refused: Google credential JSON is Agent-dedicated; use project scope.' }] };
      }
      if (!['project', 'workspace'].includes(scope)) {
        return { isError: true, content: [{ type: 'text' as const, text: 'Credential Vault input refused: scope must be project or workspace.' }] };
      }
      if (scope === 'project' && !ctx.projectId) {
        return { isError: true, content: [{ type: 'text' as const, text: 'Credential Vault input refused: current session has no project.' }] };
      }
      if (!ctx.userId) {
        return { isError: true, content: [{ type: 'text' as const, text: 'Credential Vault input refused: authenticated requester is required.' }] };
      }
      try {
        await assertCredentialManagementAccess({ actorUserId: ctx.userId, scope, projectId: scope === 'project' ? ctx.projectId : undefined });
      } catch {
        return { isError: true, content: [{ type: 'text' as const, text: 'Credential Vault input refused: current connection management access could not be verified.' }] };
      }
      return {
        content: [{ type: 'text' as const, text: 'Secure credential input requested. Browser display and credential saving are not confirmed by this tool result. Secret value is handled only by the browser and Credential Vault.' }],
        details: { secureInput: true },
      };
    },
  } as ToolDefinition;
}
