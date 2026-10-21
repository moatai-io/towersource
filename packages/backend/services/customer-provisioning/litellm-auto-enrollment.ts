import { issueAndDeliverCustomerCredential, type ApprovedDelivery, type CentralIssuancePorts, type DeliveryReceipt } from './central-delivery.js';
import type { LiteLlmManagementPort } from './litellm-key-issuer.js';

/** New customer only. Caller consumes a durable approved intent and verifies
 * the target receiver BEFORE entering this adapter. No rotation/replay here.
 */
export interface AutoLiteLlmEnrollmentPolicy {
  customerId: string; instanceId: string; approvalHash: string; policyHash: string; credentialId: string;
  teamId: string; teamAlias: string; keyAlias: string; models: string[];
  monthlyBudgetUsd: 50; budgetDuration: '30d';
  /** Explicit immutable approval profile; never selected by the incoming request. */
  modelPolicy?: 'gpt-only';
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(x);
const sameModels = (actual: unknown, expected: string[]) => Array.isArray(actual) && actual.length === expected.length && [...actual].sort().every((x, i) => x === [...expected].sort()[i]);
const requiredModels = ['gpt-6.1-sol', '~deepseek/deepseek-pro-latest', 'z-ai/glm-5.3'];

/** Supported provisioning entrypoint: durable intent + attested receiver first,
 * automatic Team/key creation second, direct Vault delivery and readback last.
 * The supervisor/Control Plane gets only the secret-free receipt.
 */
export async function autoEnrollAndDeliverLiteLlmCustomer(input: ApprovedDelivery, policy: AutoLiteLlmEnrollmentPolicy,
  management: LiteLlmManagementPort, ports: Omit<CentralIssuancePorts, 'issue'>): Promise<DeliveryReceipt> {
  return issueAndDeliverCustomerCredential(input, {
    consumeAndVerifyReceiver: value => ports.consumeAndVerifyReceiver(value),
    async issue(value) {
      const issued = await autoEnrollApprovedLiteLlmCustomer(value, policy, management);
      return { providerResourceId: issued.providerResourceId, value: issued.value };
    },
    deliver: value => ports.deliver(value),
    readback: value => ports.readback(value),
  });
}

function assertApprovedPolicy(input: ApprovedDelivery, policy: AutoLiteLlmEnrollmentPolicy): void {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (input.providerKind !== 'litellm' || !uuid.test(input.intentId) || !uuid.test(input.instanceId)
    || !identifier(input.customerId) || !identifier(input.credentialId)
    || !/^[a-f0-9]{64}$/.test(input.approvalHash) || !/^[a-f0-9]{64}$/.test(input.policyHash)
    || ['customerId', 'instanceId', 'approvalHash', 'policyHash', 'credentialId'].some(k => input[k as keyof ApprovedDelivery] !== policy[k as keyof AutoLiteLlmEnrollmentPolicy])
    || !identifier(policy.teamId) || !identifier(policy.teamAlias) || !identifier(policy.keyAlias)
    || policy.monthlyBudgetUsd !== 50 || policy.budgetDuration !== '30d'
    || !Array.isArray(policy.models) || policy.models.length < 1 || policy.models.length > 32
    || new Set(policy.models).size !== policy.models.length
    || policy.models.some(x => typeof x !== 'string' || !x.trim() || x !== x.trim() || x.length > 240 || /[\s\u0000-\u001f]/.test(x))
    || (policy.modelPolicy === 'gpt-only'
      ? policy.models.length !== 1 || policy.models[0] !== 'gpt-6.1-sol'
      : policy.modelPolicy !== undefined || requiredModels.some(id => !policy.models.includes(id)))) throw new Error('litellm_auto_policy_invalid');
}
function metadataMatches(x: unknown, policy: AutoLiteLlmEnrollmentPolicy): boolean {
  return object(x) && x.customer_id === policy.customerId && x.instance_id === policy.instanceId
    && x.approval_hash === policy.approvalHash && x.policy_hash === policy.policyHash;
}
function expectedTeam(x: unknown, policy: AutoLiteLlmEnrollmentPolicy): boolean {
  return object(x) && x.team_id === policy.teamId && x.team_alias === policy.teamAlias
    && sameModels(x.models, policy.models) && x['max_budget'] === Number(process.env.TOWER_LITELLM_AUTO_ENROLLMENT_MONTHLY_BUDGET || '50') && x.budget_duration === '30d' && x.blocked !== true;
}
function completeKeys(payload: unknown, policy: AutoLiteLlmEnrollmentPolicy): Record<string, unknown>[] {
  if (!object(payload) || !Array.isArray(payload.keys) || payload.keys.length > 100 || payload.total_count !== payload.keys.length
    || (typeof payload.total_pages === 'number' && payload.total_pages > 1)
    || payload.keys.some(key => !object(key) || key.team_id !== policy.teamId || !identifier(key.key_alias))) throw new Error('litellm_key_inventory_incomplete');
  return payload.keys as Record<string, unknown>[];
}
function keyInventoryPath(policy: AutoLiteLlmEnrollmentPolicy): string {
  return '/key/list?team_id=' + encodeURIComponent(policy.teamId) + '&page=1&size=100&return_full_object=true';
}
function exactKey(keys: Record<string, unknown>[], policy: AutoLiteLlmEnrollmentPolicy): void {
  const readback = keys.filter(key => key.key_alias === policy.keyAlias);
  if (readback.length !== 1 || !sameModels(readback[0].models, policy.models) || readback[0].max_budget !== 50
    || readback[0].budget_duration !== '30d' || readback[0].blocked === true || !metadataMatches(readback[0].metadata, policy)
    || !object(readback[0].metadata) || readback[0].metadata.credential_id !== policy.credentialId) throw new Error('litellm_key_readback_unknown_no_replay');
}
/** Independent later provider readback. No key value, issuance or repair exits this port. */
export async function readApprovedAutoLiteLlmCustomer(input: ApprovedDelivery, policy: AutoLiteLlmEnrollmentPolicy, management: LiteLlmManagementPort): Promise<{providerResourceId: string}> {
  assertApprovedPolicy(input, policy);
  let team: unknown, keys: Record<string, unknown>[];
  try {
    team = await management.request('/team/info?team_id=' + encodeURIComponent(policy.teamId), 'GET');
    keys = completeKeys(await management.request(keyInventoryPath(policy), 'GET'), policy);
  } catch { throw new Error('litellm_provider_readback_unverified'); }
  const teamInfo = object(team) ? (team.team_info ?? team) : null;
  if (!expectedTeam(teamInfo, policy) || !object(teamInfo) || !metadataMatches(teamInfo.metadata, policy)) throw new Error('litellm_provider_readback_unverified');
  try { exactKey(keys, policy); } catch { throw new Error('litellm_provider_readback_unverified'); }
  return {providerResourceId: policy.keyAlias};
}

export async function autoEnrollApprovedLiteLlmCustomer(
  input: ApprovedDelivery, policy: AutoLiteLlmEnrollmentPolicy, management: LiteLlmManagementPort,
): Promise<{ providerResourceId: string; value: string; teamId: string; teamCreated: boolean }> {
  assertApprovedPolicy(input, policy);
  // /models on the serving management adapter, not a dormant alternate router.
  const catalog = await management.request('/models', 'GET');
  const catalogRows: unknown[] | null = object(catalog) && Array.isArray(catalog.data) ? catalog.data : null;
  if (!catalogRows || policy.models.some(id => !catalogRows.some(row => object(row) && row.id === id))) throw new Error('litellm_auto_model_catalog_mismatch');
  const listing = await management.request('/team/list', 'GET');
  const teams = Array.isArray(listing) ? listing : object(listing) && Array.isArray(listing.teams) ? listing.teams : null;
  if (!teams || teams.length > 1000 || teams.some(x => !object(x))) throw new Error('litellm_team_inventory_incomplete');
  const matches = teams.filter(x => x.team_id === policy.teamId || x.team_alias === policy.teamAlias);
  if (matches.length > 1) throw new Error('litellm_team_identity_conflict');
  let teamCreated = false;
  if (matches.length) {
    if (!expectedTeam(matches[0], policy) || !metadataMatches(matches[0].metadata, policy)) throw new Error('litellm_team_policy_conflict');
  } else {
    // Unknown creation outcomes must not be treated as permission to retry.
    let response: unknown;
    try { response = await management.request('/team/new', 'POST', {
      team_id: policy.teamId, team_alias: policy.teamAlias, models: [...policy.models], max_budget: 50, budget_duration: '30d',
      metadata: { customer_id: policy.customerId, instance_id: policy.instanceId, approval_hash: policy.approvalHash, policy_hash: policy.policyHash },
    }); } catch { throw new Error('litellm_team_creation_unknown_no_replay'); }
    if (!expectedTeam(response, policy)) throw new Error('litellm_team_creation_unknown_no_replay');
    teamCreated = true;
  }
  const team = await management.request('/team/info?team_id=' + encodeURIComponent(policy.teamId), 'GET');
  const teamInfo = object(team) ? (team.team_info ?? team) : null;
  if (!expectedTeam(teamInfo, policy) || !object(teamInfo) || !metadataMatches(teamInfo.metadata, policy)) throw new Error('litellm_team_readback_mismatch');
  // A stable key alias provides an independent collision fence. Never hash a
  // secret into a reusable resource identifier or emit a secret in a receipt.
  const keys = completeKeys(await management.request(keyInventoryPath(policy), 'GET'), policy);
  if (keys.some(key => key.key_alias === policy.keyAlias)) throw new Error('litellm_key_already_exists_do_not_rotate');
  let created: unknown;
  try { created = await management.request('/key/generate', 'POST', {
    team_id: policy.teamId, key_alias: policy.keyAlias, models: [...policy.models], max_budget: 50, budget_duration: '30d',
    metadata: { customer_id: policy.customerId, instance_id: policy.instanceId, approval_hash: policy.approvalHash, policy_hash: policy.policyHash, credential_id: policy.credentialId },
  }); } catch { throw new Error('litellm_key_creation_unknown_no_replay'); }
  if (!object(created) || typeof created.key !== 'string' || !created.key.trim() || created.team_id !== policy.teamId || created.key_alias !== policy.keyAlias)
    throw new Error('litellm_key_creation_unknown_no_replay');
  let readKeys: Record<string, unknown>[];
  try { readKeys = completeKeys(await management.request(keyInventoryPath(policy), 'GET'), policy); } catch { throw new Error('litellm_key_readback_unknown_no_replay'); }
  exactKey(readKeys, policy);
  // key_alias is independent of key/token bytes and remains a valid resource
  // reference even on LiteLLM versions whose response has no key_id/token_id.
  return { providerResourceId: policy.keyAlias, value: created.key, teamId: policy.teamId, teamCreated };
}
