import { resolveProjectApiKeySecretValue, upsertApiKeyCredential } from '../credential-vault/credential-vault-service.js';
import { assertCredentialManagementAccess } from '../credential-vault/credential-management-access.js';

const ZUPLO_DEVELOPER_API_BASE = 'https://dev.zuplo.com/v1';
const USER_AGENT = 'Tower-Gateway-Key-Issuance/1.0';

export type ZuploKeyOperation = 'issue' | 'rotate';

export interface ZuploKeyIssueAndStoreInput {
  operation: ZuploKeyOperation;
  actorUserId: number;
  projectId: string;
  account: string;
  bucketId: string;
  consumerName: string;
  consumerDescription?: string;
  consumerMetadata?: Record<string, string>;
  consumerTags?: Record<string, string>;
  expiresOn?: string;
  credentialId: string;
  credentialEnvName: string;
  credentialDisplayName: string;
  confirmed: true;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface ZuploKeyIssueAndStoreResult {
  operation: ZuploKeyOperation;
  account: string;
  bucketId: string;
  consumerId: string | null;
  consumerName: string;
  keyId: string;
  credentialId: string;
  credentialEnvName: string;
  credentialScope: 'workspace';
  stored: true;
}

export class ZuploKeyIssuanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new ZuploKeyIssuanceError('ZUPLO_KEY_INPUT_INVALID', `${label} is invalid`);
  }
  return encodeURIComponent(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractIssuedKey(payload: unknown): { consumerId: string | null; keyId: string; value: string } {
  const root = asRecord(payload);
  const consumer = asRecord(root.consumer);
  const apiKeys = Array.isArray(root.apiKeys) ? root.apiKeys : Array.isArray(consumer.apiKeys) ? consumer.apiKeys : [];
  const candidate = asRecord(apiKeys[0] ?? root.apiKey ?? root.key);
  const value = stringValue(candidate, 'key', 'value') ?? (typeof root.key === 'string' ? root.key.trim() : null);
  const keyId = stringValue(candidate, 'id', 'keyId') ?? stringValue(root, 'keyId', 'apiKeyId');
  const consumerId = stringValue(root, 'id', 'consumerId') ?? stringValue(consumer, 'id', 'consumerId');
  if (!value || !keyId) throw new ZuploKeyIssuanceError('ZUPLO_KEY_RESPONSE_INVALID', 'Zuplo returned no storable key receipt');
  return { consumerId, keyId, value };
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 1_000_000) throw new ZuploKeyIssuanceError('ZUPLO_KEY_RESPONSE_TOO_LARGE', 'Zuplo response exceeded the safe size limit');
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

export async function issueOrRotateZuploKeyAndStore(input: ZuploKeyIssueAndStoreInput): Promise<ZuploKeyIssueAndStoreResult> {
  if (input.confirmed !== true) throw new ZuploKeyIssuanceError('ZUPLO_KEY_CONFIRMATION_REQUIRED', 'Exact issue or rotate approval is required');
  await assertCredentialManagementAccess({ actorUserId: input.actorUserId, scope: 'project', projectId: input.projectId });
  await assertCredentialManagementAccess({ actorUserId: input.actorUserId, scope: 'workspace', action: 'admin' });

  const managementCredential = await resolveProjectApiKeySecretValue({
    projectId: input.projectId,
    userId: input.actorUserId,
    envName: 'ZUPLO_API_KEY',
    targetType: 'zuplo-key-issuance',
  });
  if (!managementCredential) throw new ZuploKeyIssuanceError('ZUPLO_MANAGEMENT_CREDENTIAL_MISSING', 'Zuplo management connection is not available');

  const account = safeSegment(input.account, 'account');
  const bucketId = safeSegment(input.bucketId, 'bucketId');
  const consumerName = safeSegment(input.consumerName, 'consumerName');
  const base = `${ZUPLO_DEVELOPER_API_BASE}/accounts/${account}/key-buckets/${bucketId}`;
  const url = input.operation === 'issue'
    ? `${base}/consumers?with-api-key=true`
    : `${base}/consumers/${consumerName}/keys/roll`;
  if (input.operation === 'rotate' && !input.expiresOn) {
    throw new ZuploKeyIssuanceError('ZUPLO_KEY_EXPIRY_REQUIRED', 'Rotate requires the old-key expiration time');
  }
  const body = input.operation === 'issue'
    ? {
        name: input.consumerName,
        description: input.consumerDescription,
        metadata: input.consumerMetadata ?? {},
        tags: input.consumerTags ?? {},
      }
    : { expiresOn: input.expiresOn };

  const response = await (input.fetchImpl ?? fetch)(url, {
    method: 'POST',
    redirect: 'error',
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${managementCredential.value}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await boundedJson(response);
  if (!response.ok) {
    throw new ZuploKeyIssuanceError('ZUPLO_KEY_PROVIDER_REJECTED', `Zuplo rejected the ${input.operation} request with HTTP ${response.status}`);
  }
  const issued = extractIssuedKey(payload);

  let credential;
  try {
    credential = await upsertApiKeyCredential({
      id: input.credentialId,
      provider: 'zuplo',
      displayName: input.credentialDisplayName,
      secretName: input.credentialEnvName,
      secretValue: issued.value,
      defaultEnvName: input.credentialEnvName,
      scope: 'workspace',
      metadata: {
        source: 'zuplo_issue_and_store',
        zuplo_account: input.account,
        zuplo_bucket_id: input.bucketId,
        zuplo_consumer_name: input.consumerName,
        zuplo_consumer_id: issued.consumerId,
        zuplo_key_id: issued.keyId,
      },
      actorUserId: input.actorUserId,
    });
  } catch {
    throw new ZuploKeyIssuanceError('ZUPLO_KEY_VAULT_STORE_FAILED', 'Zuplo issued a key but Vault storage failed; recovery is required before retry');
  }

  return {
    operation: input.operation,
    account: input.account,
    bucketId: input.bucketId,
    consumerId: issued.consumerId,
    consumerName: input.consumerName,
    keyId: issued.keyId,
    credentialId: credential.id,
    credentialEnvName: credential.default_env_name ?? input.credentialEnvName,
    credentialScope: 'workspace',
    stored: true,
  };
}
