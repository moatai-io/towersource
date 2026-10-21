import { gzipSync } from 'node:zlib';
import { CredentialInputError, normalizeSecretInput } from './credential-input-normalizer.js';

export type GoogleCredentialJsonType = 'authorized_user' | 'service_account';
export interface ValidatedGoogleCredentialJson {
  type: GoogleCredentialJsonType;
  accountHint: string;
  canonicalJson: string;
  encodedGwsBundle: string;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) throw new CredentialInputError('INVALID_GOOGLE_CREDENTIAL_JSON', `Google credential JSON is missing ${key}`);
  return field;
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name); header.write('0000600\0', 100, 8);
  header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('00000000000\0', 136, 12); header.fill(32, 148, 156);
  header.write('0', 156, 1); header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

/** Validate a user-supplied Google credential document and package only the
 * exact canonical document as root gws/credentials.json. No cache or user path. */
export function validateAndBundleGoogleCredentialJson(raw: unknown): ValidatedGoogleCredentialJson {
  const normalized = normalizeSecretInput(raw, { inputKind: 'json', trim: 'outer' });
  const parsed = JSON.parse(normalized.value) as Record<string, unknown>;
  if (!parsed || Array.isArray(parsed)) throw new CredentialInputError('INVALID_GOOGLE_CREDENTIAL_JSON', 'Google credential JSON must be an object');
  const type = parsed.type;
  let accountHint: string;
  if (type === 'authorized_user') {
    for (const key of ['client_id', 'client_secret', 'refresh_token']) requiredString(parsed, key);
    accountHint = typeof parsed.account === 'string' && parsed.account.trim() ? parsed.account.trim() : 'authorized user';
  } else if (type === 'service_account') {
    for (const key of ['project_id', 'private_key_id', 'private_key', 'client_email', 'token_uri']) requiredString(parsed, key);
    const privateKey = requiredString(parsed, 'private_key');
    if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(privateKey)) {
      throw new CredentialInputError('INVALID_GOOGLE_CREDENTIAL_JSON', 'Google service account private_key is invalid');
    }
    accountHint = requiredString(parsed, 'client_email');
  } else {
    throw new CredentialInputError('UNSUPPORTED_GOOGLE_CREDENTIAL_TYPE', 'Google credential type must be authorized_user or service_account');
  }
  const canonicalJson = normalized.value;
  const content = Buffer.from(canonicalJson, 'utf8');
  const encodedGwsBundle = gzipSync(Buffer.concat([
    tarHeader('gws/credentials.json', content.length), content,
    Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024),
  ])).toString('base64');
  return { type, accountHint, canonicalJson, encodedGwsBundle };
}
