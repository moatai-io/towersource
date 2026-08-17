export type CredentialRevealMode = 'reveal' | 'compare' | 'inspect';
export type CredentialRevealPolicy = 'allow' | 'masked_json' | 'deny';

export interface CredentialRevealDescriptor {
  kind: string;
  secretName: string;
  metadata?: Record<string, unknown>;
}

export function credentialRevealPolicy(input: CredentialRevealDescriptor): CredentialRevealPolicy {
  const kind = input.kind.toLowerCase();
  const secretName = input.secretName.toUpperCase();
  const typeId = typeof input.metadata?.credential_type_id === 'string'
    ? input.metadata.credential_type_id.toLowerCase()
    : '';

  if (kind.includes('ssh') || typeId.includes('ssh') || secretName.includes('PRIVATE_KEY')) return 'deny';
  if (kind.includes('oauth') || typeId.includes('oauth') || /(?:ACCESS|REFRESH|ID)_TOKEN/.test(secretName)) return 'deny';
  if (kind.includes('json') || typeId.includes('json') || secretName.endsWith('_JSON')) return 'masked_json';
  return 'allow';
}

export interface CredentialAllowedActions {
  compare: boolean;
  reveal: boolean;
  inspect: boolean;
  replacementAction: 'rotate' | 'reauth';
  reason: 'ordinary_secret' | 'structured_credential' | 'oauth_token' | 'ssh_private_key';
}

export function credentialAllowedActions(input: CredentialRevealDescriptor): CredentialAllowedActions {
  const policy = credentialRevealPolicy(input);
  const kind = input.kind.toLowerCase();
  const typeId = typeof input.metadata?.credential_type_id === 'string' ? input.metadata.credential_type_id.toLowerCase() : '';
  const oauth = kind.includes('oauth') || typeId.includes('oauth') || /(?:ACCESS|REFRESH|ID)_TOKEN/.test(input.secretName.toUpperCase());
  const ssh = kind.includes('ssh') || typeId.includes('ssh') || input.secretName.toUpperCase().includes('PRIVATE_KEY');
  return {
    compare: policy === 'allow',
    reveal: policy === 'allow',
    inspect: true,
    replacementAction: oauth ? 'reauth' : 'rotate',
    reason: oauth ? 'oauth_token' : ssh ? 'ssh_private_key' : policy === 'masked_json' ? 'structured_credential' : 'ordinary_secret',
  };
}

export function assertRevealAllowed(input: CredentialRevealDescriptor, mode: CredentialRevealMode): CredentialRevealPolicy {
  const policy = credentialRevealPolicy(input);
  if (mode === 'inspect') return policy;
  if (policy !== 'allow') {
    const error = new Error(policy === 'masked_json' ? 'Structured Credential cannot be revealed in full' : 'Credential type cannot be revealed');
    (error as Error & { code?: string }).code = policy === 'masked_json' ? 'REVEAL_MASKED_ONLY' : 'REVEAL_FORBIDDEN';
    throw error;
  }
  return policy;
}
