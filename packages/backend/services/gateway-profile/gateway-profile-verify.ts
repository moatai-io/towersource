import { query, execute } from '../../db/pg-repo.js';
import { revealCredentialValue } from '../credential-vault/credential-vault-service.js';

const PROFILE_ID = 'tower-shared-api-v1';
const VERIFY_TIMEOUT_MS = 8_000;
const OPENAI_IMAGE_VERIFY_TIMEOUT_MS = 30_000;
const SUPPORTED_VERIFY_APIS = new Set(['agent-store', 'naver', 'openrouter-jev', 'openai-image']);
const MAX_IMAGE_VERIFY_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type GatewayVerifyResult = {
  profileId: string;
  status: 'ready' | 'degraded';
  verified: boolean;
  httpStatus?: number;
  checkedApi: string;
  errorCode?: string;
  verifiedAt: string;
};

type VerifyTarget = {
  path: string;
  init: RequestInit;
  validate(body: any): boolean;
  invalidResponseCode: string;
  timeoutMs?: number;
};

function verificationTarget(apiId: string, apiKey: string): VerifyTarget {
  if (apiId === 'agent-store') {
    return {
      path: '/agent-store/mcp',
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tower-gateway-verify', version: '1' } } }),
      },
      validate: body => typeof body?.result?.protocolVersion === 'string',
      invalidResponseCode: 'gateway_invalid_initialize_response',
    };
  }
  if (apiId === 'naver') {
    return {
      path: '/naver/search/news.json?query=Tower&display=1&start=1&sort=sim',
      init: { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
      validate: body => Array.isArray(body?.items) && typeof body?.total === 'number',
      invalidResponseCode: 'gateway_invalid_naver_response',
    };
  }
  if (apiId === 'openrouter-jev') {
    return {
      path: '/inference/openrouter/api/alpha/decisions',
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: 'typesafe/jev-1.13',
          state: { canary: 'gateway-readiness' },
          questions: {
            readiness: {
              type: 'choice',
              instructions: 'Choose ready for this bounded connectivity check.',
              criteria: { ready: 'The request can be evaluated.', not_ready: 'The request cannot be evaluated.' },
            },
          },
        }),
      },
      validate: body => {
        const answer = body?.answers?.readiness;
        return typeof body?.provider === 'string' && body.provider.length > 0
          && typeof body?.model === 'string' && body.model.startsWith('typesafe/jev-1.13')
          && answer?.type === 'choice'
          && answer.choice === 'ready'
          && answer.probabilities && typeof answer.probabilities === 'object' && !Array.isArray(answer.probabilities)
          && typeof answer.confidence === 'number' && Number.isFinite(answer.confidence);
      },
      invalidResponseCode: 'gateway_invalid_openrouter_jev_response',
    };
  }
  if (apiId === 'openai-image') {
    return {
      path: '/openai/images/generations',
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: 'gpt-image-2.5-sunburst',
          prompt: 'A single small neutral blue circle on a white background. No text.',
          size: '1024x1024',
          quality: 'low',
          n: 1,
          output_format: 'png',
        }),
      },
      validate: body => {
        const encoded = body?.data?.[0]?.b64_json;
        if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > Math.ceil(MAX_IMAGE_VERIFY_BYTES * 4 / 3) + 4) return false;
        try {
          const image = Buffer.from(encoded, 'base64');
          return image.length >= PNG_SIGNATURE.length
            && image.length <= MAX_IMAGE_VERIFY_BYTES
            && image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
        } catch {
          return false;
        }
      },
      invalidResponseCode: 'gateway_invalid_openai_image_response',
      timeoutMs: OPENAI_IMAGE_VERIFY_TIMEOUT_MS,
    };
  }
  throw new Error('Gateway API verification is not supported');
}

export async function verifyGatewayProfile(opts: {
  actorUserId: number;
  profileId?: string;
  apiId?: string;
  fetcher?: typeof fetch;
}): Promise<GatewayVerifyResult> {
  const profileId = opts.profileId || PROFILE_ID;
  const apiId = opts.apiId || 'agent-store';
  if (!SUPPORTED_VERIFY_APIS.has(apiId)) throw new Error('Gateway API verification is not supported');
  const rows = await query<any>(
    `SELECT gp.id, gp.gateway_base_url, gp.credential_id, gp.status,
            ce.api_id, ce.enabled
       FROM gateway_profiles gp
       LEFT JOIN gateway_profile_catalog_entries ce
         ON ce.profile_id = gp.id AND ce.api_id = $2
      WHERE gp.id = $1
      LIMIT 1`,
    [profileId, apiId],
  );
  const profile = rows[0];
  if (!profile) throw new Error('Gateway Profile not found');
  if (!profile.gateway_base_url || !profile.credential_id) throw new Error('Gateway Profile is not provisioned');
  if (!profile.api_id || profile.enabled !== true) throw new Error('Gateway API is not enabled');

  const credential = await revealCredentialValue({ credentialId: profile.credential_id, actorUserId: opts.actorUserId, purpose: `bounded ${apiId} gateway readiness verification` });
  const base = String(profile.gateway_base_url).replace(/\/$/, '');
  const target = verificationTarget(apiId, credential.value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? VERIFY_TIMEOUT_MS);
  const fetcher = opts.fetcher ?? fetch;
  let httpStatus: number | undefined;
  let status: 'ready' | 'degraded' = 'degraded';
  let errorCode: string | undefined;
  try {
    const response = await fetcher(`${base}${target.path}`, { ...target.init, redirect: 'error', signal: controller.signal });
    httpStatus = response.status;
    status = response.ok ? 'ready' : 'degraded';
    if (!response.ok) errorCode = `gateway_http_${response.status}`;
    else {
      const body = await response.json().catch(() => null) as any;
      if (!target.validate(body)) { status = 'degraded'; errorCode = target.invalidResponseCode; }
    }
  } catch (error: any) {
    errorCode = error?.name === 'AbortError' ? 'gateway_verify_timeout' : 'gateway_verify_request_failed';
  } finally {
    clearTimeout(timer);
  }
  const verifiedAt = new Date().toISOString();
  if (apiId === 'agent-store') {
    await execute(
      `UPDATE gateway_profiles SET status = $2, last_verified_at = $3, last_error_code = $4, updated_at = NOW() WHERE id = $1`,
      [profileId, status, verifiedAt, errorCode ?? null],
    );
  }
  await execute(
    `UPDATE gateway_profile_catalog_entries
        SET readiness = CASE WHEN $3 = 'ready' AND enabled THEN 'ready' WHEN enabled THEN 'degraded' ELSE 'disabled' END,
            metadata = metadata || jsonb_build_object('lastVerifiedAt', $4::text, 'lastErrorCode', $5::text),
            updated_at = NOW()
      WHERE profile_id = $1 AND api_id = $2`,
    [profileId, apiId, status, verifiedAt, errorCode ?? ''],
  );
  return { profileId, status, verified: status === 'ready', httpStatus, checkedApi: apiId, errorCode, verifiedAt };
}
