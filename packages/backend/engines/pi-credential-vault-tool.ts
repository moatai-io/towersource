import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

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
    Type.Literal('personal'),
    Type.Literal('workspace'),
  ], { description: 'Default project means the current Agent. personal is legacy explicit-only; workspace requires admin permission.' })),
  grantToCurrentProject: Type.Optional(Type.Boolean({ description: 'Connect the credential to the current Agent after saving. Defaults true for project scope.' })),
  purpose: Type.Optional(Type.String({ description: 'Short allowed-use note stored as metadata.' })),
  handlingNote: Type.Optional(Type.String({ description: 'Short sensitivity/handling note stored as metadata.' })),
});

export function createCredentialVaultInputTool(ctx: { userRole?: string; projectId?: string }): ToolDefinition {
  return {
    name: 'credential_vault_input',
    label: 'Credential Vault Input',
    description: 'Open a secure password field that saves a credential directly to Tower Credential Vault. The secret never enters chat or AI context.',
    promptSnippet: 'Use credential_vault_input for API keys, passwords, login credentials, tokens, or other env-style secrets after the user asks to register or rotate one, or accepts an offer to open a secure input. Never request the value in chat.',
    promptGuidelines: [
      'Never ask the user to paste a secret into chat. If a workflow discovers a missing credential, offer to open a secure input (for example, “안전 입력창을 열어드릴까요?”) and wait for consent instead of directing the user to Credential Vault or opening it without notice. If the user already explicitly asked to register or rotate the credential, that request is sufficient consent to open it.',
      'Use it for operational credentials such as API keys, account passwords, login pairs, tokens, private keys, and validated credential JSON. It is not a general-purpose store for identity documents, financial records, medical information, or arbitrary private notes.',
      'Use scope=project and grantToCurrentProject=true by default. In the product model this creates an Agent Connection for the current Agent, including user-owned operational accounts used by that Agent.',
      'Use scope=personal only when the user explicitly requests the legacy personal Connection model. Use workspace only when an admin explicitly requests an Organization Connection.',
      'Use inputType=value for one secret, fields for multiple environment secrets, and json for a validated JSON document.',
      'For fields, provide each environment variable in fields; envName is not required. For value/json, envName is required.',
      'This tool opens the secure input UI; it does not receive or return the secret value.',
      'If the credential id already exists with the same provider/env/scope, saving rotates its value. Conflicting metadata is rejected safely.',
    ],
    parameters: Params,
    async execute(_toolCallId: string, params: any) {
      const scope = params.scope || 'project';
      const inputType = params.inputType || 'value';
      if (inputType === 'fields' ? !params.fields?.length : !params.envName) {
        return { content: [{ type: 'text' as const, text: `Credential Vault input refused: ${inputType === 'fields' ? 'fields' : 'envName'} is required.` }] };
      }
      if (scope === 'workspace' && !['admin', 'operator'].includes(ctx.userRole || '')) {
        return { content: [{ type: 'text' as const, text: 'Credential Vault input refused: workspace scope requires admin/operator.' }] };
      }
      if (scope === 'project' && !ctx.projectId) {
        return { content: [{ type: 'text' as const, text: 'Credential Vault input refused: current session has no project.' }] };
      }
      return {
        content: [{ type: 'text' as const, text: 'Secure credential input opened. Secret value is handled only by the browser and Credential Vault.' }],
        details: { secureInput: true },
      };
    },
  } as ToolDefinition;
}
