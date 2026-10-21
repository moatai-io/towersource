export type SecretInputKind = 'opaque_token' | 'authorization_value' | 'password' | 'private_key' | 'json' | 'opaque';

export interface SecretNormalizationPolicy {
  inputKind: SecretInputKind;
  trim?: 'none' | 'outer';
  stripSchemes?: string[];
  rejectNewlines?: boolean;
  rejectInternalWhitespace?: boolean;
  minLength?: number;
}

export interface SecretNormalizationResult {
  value: string;
  normalizations: string[];
}

export class CredentialInputError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const TOKEN_FIELD = /(api[_-]?key|token|secret|authorization|credential)/i;

export function inferSecretPolicy(input: {
  provider?: string;
  fieldId?: string;
  envName?: string;
  credentialType?: string;
}): SecretNormalizationPolicy {
  if (input.credentialType === 'ssh_private_key' || input.credentialType === 'private_key' || /private[_-]?key/i.test(input.fieldId || '') || /PRIVATE[_-]?KEY/i.test(input.envName || '') || /SSH.*KEY/i.test(input.envName || '')) {
    return { inputKind: 'private_key', trim: 'outer' };
  }
  if (/password/i.test(input.fieldId || '') || /PASSWORD/i.test(input.envName || '')) {
    return { inputKind: 'password', trim: 'none' };
  }
  if (/json|credentials_blob|credentials_json/i.test(`${input.fieldId || ''} ${input.envName || ''}`)) {
    return { inputKind: 'json', trim: 'outer' };
  }
  if (TOKEN_FIELD.test(`${input.fieldId || ''} ${input.envName || ''}`)) {
    return { inputKind: 'opaque_token', trim: 'outer', stripSchemes: ['Bearer'], rejectNewlines: true, rejectInternalWhitespace: true, minLength: 3 };
  }
  return { inputKind: 'opaque', trim: 'none' };
}

export function normalizeSecretInput(raw: unknown, policy: SecretNormalizationPolicy): SecretNormalizationResult {
  if (typeof raw !== 'string') throw new CredentialInputError('INVALID_SECRET_TYPE', 'Credential value must be a string');
  let value = raw;
  const normalizations: string[] = [];

  if (policy.inputKind === 'private_key') {
    if (value.includes('\r\n')) {
      value = value.replace(/\r\n/g, '\n');
      normalizations.push('normalized_line_endings');
    }
    const trimmed = value.trim();
    if (trimmed !== value) {
      value = trimmed;
      normalizations.push('removed_outer_whitespace');
    }
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(value)) {
      throw new CredentialInputError('INVALID_PRIVATE_KEY_SHAPE', 'Private key header or footer is invalid');
    }
  } else if (policy.inputKind === 'json') {
    const trimmed = value.trim();
    if (trimmed !== value) normalizations.push('removed_outer_whitespace');
    try {
      value = JSON.stringify(JSON.parse(trimmed));
      if (value !== trimmed) normalizations.push('canonicalized_json');
    } catch {
      throw new CredentialInputError('INVALID_JSON_CREDENTIAL', 'Credential JSON is invalid');
    }
  } else if (policy.trim === 'outer') {
    const trimmed = value.trim();
    if (trimmed !== value) {
      value = trimmed;
      normalizations.push('removed_outer_whitespace');
    }
  }

  const schemes = policy.stripSchemes ?? [];
  for (const scheme of schemes) {
    const match = value.match(new RegExp(`^${scheme}\\s+(.+)$`, 'i'));
    if (match) {
      value = match[1];
      normalizations.push('removed_authorization_scheme');
      break;
    }
    if (new RegExp(`^${scheme}$`, 'i').test(value)) {
      throw new CredentialInputError('MISSING_TOKEN_AFTER_SCHEME', `${scheme} prefix has no token`);
    }
  }

  if (!value) throw new CredentialInputError('EMPTY_SECRET', 'Credential value is empty');
  if (policy.rejectNewlines && /[\r\n]/.test(value)) throw new CredentialInputError('SECRET_CONTAINS_NEWLINE', 'Token must not contain a newline');
  if (policy.rejectInternalWhitespace && /\s/.test(value)) throw new CredentialInputError('SECRET_CONTAINS_WHITESPACE', 'Token must not contain whitespace');
  if (policy.minLength && value.length < policy.minLength) throw new CredentialInputError('SECRET_TOO_SHORT', 'Credential value is too short');

  return { value, normalizations: [...new Set(normalizations)] };
}
