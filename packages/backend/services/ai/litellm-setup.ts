/** Operator-only service; callers must authorize VM configuration writes. */
import { loadModelsFile, saveModelsFile, reloadModels } from '../../config.js';
import { getSecret, setSecret } from '../secret/secret-store.js';
import { randomUUID } from 'node:crypto';
import { initializeCustomerAiDefaults } from './customer-model-bootstrap.js';

type SetupInput = { baseUrl: string; actorUserId: number; bootstrapDefaults?: boolean; customerProfile?: import('./customer-model-bootstrap.js').CustomerAiProfile };
const MAX_CATALOG_BYTES = 1_048_576;
const validActor = (actorUserId: number) => Number.isSafeInteger(actorUserId) && actorUserId > 0;

function normalizedBaseUrl(value: string): string {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
    return u.toString().replace(/\/+$/, '');
  } catch { throw new Error('Invalid LiteLLM base URL'); }
}

async function readCatalog(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_CATALOG_BYTES)) {
    await response.body?.cancel();
    throw new Error('LiteLLM Team catalog exceeded size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('LiteLLM Team catalog returned invalid JSON');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) throw new Error('LiteLLM Team catalog exceeded size limit');
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error(bytes > MAX_CATALOG_BYTES ? 'LiteLLM Team catalog exceeded size limit' : 'LiteLLM Team catalog read failed');
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('LiteLLM Team catalog returned invalid JSON'); }
}

async function probeAndPrepare(input: SetupInput, apiKey: string) {
  if (!validActor(input.actorUserId)) throw new Error('Authenticated operator required');
  const baseUrl = normalizedBaseUrl(input.baseUrl);
  if (!apiKey.trim()) throw new Error('LiteLLM API key required');
  // Authenticate and bound the actual Team catalog before any Vault/config write.
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, { redirect: 'error', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error('LiteLLM connection probe failed'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`LiteLLM connection probe failed (HTTP ${response.status})`);
  }
  const catalog = input.bootstrapDefaults === true ? await readCatalog(response) : undefined;
  if (input.bootstrapDefaults !== true) await response.body?.cancel();
  const now = new Date().toISOString();
  // Reload after network/body awaits so later administrator choices win.
  const current = loadModelsFile();
  const next = input.bootstrapDefaults === true
    ? initializeCustomerAiDefaults(current, catalog, now, input.customerProfile).file
    : structuredClone(current);
  return { baseUrl, now, next };
}

export async function configureLiteLLMVm(input: SetupInput & { apiKey: string }): Promise<{ restartRequired: true }> {
  const apiKey = input.apiKey.trim();
  const { baseUrl, now, next } = await probeAndPrepare(input, apiKey);
  // Immutable generations: failed config persistence cannot rotate active key.
  const secretName = 'TOWER_INFERENCE_LITELLM_KEY_' + randomUUID().replace(/-/g, '').toUpperCase();
  await setSecret({ name: secretName, value: apiKey, scope: 'global', createdBy: input.actorUserId, description: 'VM inference credential; not a project tool connection' });
  saveModelsFile({ ...next, inferenceProviders: { ...next.inferenceProviders, 'litellm-responses': { baseUrl, secretName, configuredAt: now } } });
  return { restartRequired: true };
}

/** Local receiver only: reuse the one key already stored in the customer Vault,
 * not a second global key row and never a provider master key. */
export async function configureCustomerLiteLLMFromVault(input: SetupInput & { secretName: string }): Promise<{ restartRequired: true }> {
  if (!validActor(input.actorUserId)) throw new Error('Authenticated operator required');
  if (!/^VAULT_[A-F0-9]{56}$/.test(input.secretName)) throw new Error('Customer LiteLLM Vault reference invalid');
  const requestedBase = normalizedBaseUrl(input.baseUrl);
  const current = loadModelsFile();
  const binding = current.inferenceProviders?.['litellm-responses'] ?? current.inferenceProviders?.litellm;
  if (binding && (binding.secretName !== input.secretName || binding.baseUrl !== requestedBase)) throw new Error('Customer LiteLLM binding already configured');
  let apiKey: string;
  try { apiKey = await getSecret(input.secretName, 0); }
  catch { throw new Error('Customer LiteLLM Vault material unavailable'); }
  const prepared = await probeAndPrepare({ ...input, bootstrapDefaults: true }, apiKey);
  const latestBinding = prepared.next.inferenceProviders?.['litellm-responses'] ?? prepared.next.inferenceProviders?.litellm;
  if (latestBinding && (latestBinding.secretName !== input.secretName || latestBinding.baseUrl !== requestedBase)) throw new Error('Customer LiteLLM binding already configured');
  saveModelsFile({ ...prepared.next, inferenceProviders: { ...prepared.next.inferenceProviders,
    'litellm-responses': { baseUrl: prepared.baseUrl, secretName: input.secretName, configuredAt: latestBinding?.configuredAt ?? prepared.now } } });
  return { restartRequired: true };
}

/** Activate the saved binding through the existing in-process model reload path.
 * Never restart a host service or interrupt a running turn from an enrollment. */
export async function activateCustomerLiteLLMRuntime(): Promise<void> {
  reloadModels();
  const { getEngine } = await import('../../engines/index.js');
  const engine = await getEngine('pi') as { reloadModelRegistry?: () => Promise<void> };
  if (!engine.reloadModelRegistry) throw new Error('Customer LiteLLM runtime activation unavailable');
  await engine.reloadModelRegistry();
}

export function assertCustomerLiteLLMBinding(input: { baseUrl: string; secretName: string }): void {
  const file = loadModelsFile();
  const binding = file.inferenceProviders?.['litellm-responses'] ?? file.inferenceProviders?.litellm;
  if (!binding || binding.baseUrl !== normalizedBaseUrl(input.baseUrl) || binding.secretName !== input.secretName) throw new Error('Customer LiteLLM binding readback mismatch');
  // The initial defaults marker is not a mandate to overwrite subsequent choices.
  if (!file.customerAiBootstrap && !binding.configuredAt) throw new Error('Customer LiteLLM initialization readback unavailable');
}
