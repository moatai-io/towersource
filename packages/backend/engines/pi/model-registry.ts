import { resolveLiteLLMCredentials } from '../../services/ai/litellm-credentials.js';
// Owns Pi auth storage and custom model registry wiring.
// Public API: PiModelRegistryManager.

import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadModelsFile, isPiModelEntryEnabledForThisVm } from '../../config.js';
import { PRODUCT_REASONING_EFFORTS } from '../../services/model-policy/reasoning-efforts.js';
import { resolveProjectApiKeySecretValue } from '../../services/credential-vault/credential-vault-service.js';
import { isAllowedTowerPiModel } from './provider-boundary.js';
import { isPiPresetMappingReady, resolvePiSessionChoice } from '../../services/model-policy/session-alias.js';
import { resolveConfiguredInferenceProviderSecret } from '../../services/ai/inference-provider-setup.js';

export class PiModelRegistryManager {
  private modelRuntime: ModelRuntime | null = null;
  private modelRuntimePromise: Promise<ModelRuntime> | null = null;
  private modelRegistry: ModelRegistry | null = null;
  private customModelKeys: Array<{ provider: string; id: string }> = [];
  private vmProviderCredentials = new Map<string, { apiKey: string; baseUrl: string }>();

  getCustomModelKeys(): Array<{ provider: string; id: string }> {
    return this.customModelKeys;
  }

  /** Apply VM-level setup Credential, then any more-specific project-granted override. */
  async applyProjectVaultApiKeyOverrides(opts: { projectId?: string; userId?: number; model?: string }): Promise<Array<{ provider: string; credentialId: string }>> {
    if (!opts.userId || !opts.model) return [];
    const provider = opts.model.split('/')[0];
    const target = provider === 'openrouter'
      ? { envName: 'OPENROUTER_API_KEY', runtimeProvider: 'openrouter' }
      : null;
    if (!target) return [];

    const runtime = await this.getModelRuntime();
    const vmCredential = await resolveConfiguredInferenceProviderSecret(provider, opts.userId);
    if (vmCredential) {
      await runtime.setRuntimeApiKey(target.runtimeProvider, vmCredential.apiKey);
    }
    if (!opts.projectId) return vmCredential ? [{ provider, credentialId: 'vm-inference-provider' }] : [];

    const resolved = await resolveProjectApiKeySecretValue({
      projectId: opts.projectId,
      userId: opts.userId,
      envName: target.envName,
      targetType: `pi-model-runtime:${provider}`,
    });
    if (!resolved) return vmCredential ? [{ provider, credentialId: 'vm-inference-provider' }] : [];

    await runtime.setRuntimeApiKey(target.runtimeProvider, resolved.value);
    console.log(`[Pi] Applied Vault API key override for explicit ${provider} session: credential=${resolved.credentialId}`);
    return [{ provider, credentialId: resolved.credentialId }];
  }

  resolvePiModel(modelStr: string): any | null {
    if (!isAllowedTowerPiModel(modelStr)) return null;
    const parts = modelStr.split('/');
    const provider = parts[0];
    const modelId = parts.slice(1).join('/');
    const candidate = this.getModelRegistry().find(provider, modelId);
    if (candidate && candidate.api !== (provider === 'openrouter' ? 'openai-completions' : 'openai-responses')) return null;
    return candidate;
  }

  resolveSessionModel(modelStr?: string): any {
    const usingDefault = !modelStr;
    if (modelStr === 'preset/core' || modelStr === 'policy/core' || !modelStr) {
      if (!isPiPresetMappingReady('preset/core')) throw new Error('MODEL_PRESET_UNAVAILABLE: Core mapping is not executable');
      modelStr = resolvePiSessionChoice('preset/core');
    } else if (modelStr === 'preset/lite' || modelStr === 'policy/lite') {
      if (!isPiPresetMappingReady('preset/lite')) throw new Error('MODEL_PRESET_UNAVAILABLE: Lite mapping is not executable');
      modelStr = resolvePiSessionChoice('preset/lite');
    }
    if (!isAllowedTowerPiModel(modelStr)) throw new Error(`Direct Pi provider is retired: ${modelStr}`);
    const requested = this.resolvePiModel(modelStr);
    if (!requested) {
      throw new Error(
        (usingDefault ? 'Configured Pi default is not available' : `Requested Pi model "${modelStr}" not available`) +
        ` with its required Router/OpenRouter transport. ` +
        `Check models.json and provider registration logs; refusing silent fallback to a different model.`
      );
    }
    return requested;
  }

  /**
   * Return Tower's canonical Pi model/auth runtime.
   *
   * Pi 0.82 moved credentials, provider composition, and request streaming from
   * AuthStorage/ModelRegistry into one async ModelRuntime. Keep initialization
   * coalesced so concurrent session starts cannot build competing provider
   * snapshots or register Tower's custom providers twice.
   */
  async getModelRuntime(): Promise<ModelRuntime> {
    if (this.modelRuntime) return this.modelRuntime;
    if (!this.modelRuntimePromise) {
      this.modelRuntimePromise = this.createModelRuntime();
    }
    try {
      return await this.modelRuntimePromise;
    } catch (error) {
      this.modelRuntimePromise = null;
      throw error;
    }
  }

  private async createModelRuntime(): Promise<ModelRuntime> {
    // Restore server-wide inference connections from encrypted Secret Store on boot.
    for (const provider of ['openrouter']) {
      const configured = await resolveConfiguredInferenceProviderSecret(provider, 0);
      if (configured) this.vmProviderCredentials.set(provider, configured);
    }
    const file = loadModelsFile();
    if (file.inferenceProviders?.['litellm-responses'] || file.inferenceProviders?.litellm || (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY)) {
      this.vmProviderCredentials.set('litellm-responses', await resolveLiteLLMCredentials());
    }
    // Tower owns its models.json schema and registers the enabled rows below.
    // Disable SDK models.json/network discovery here so an upstream refresh
    // cannot replace Tower's provider routing or make startup network-dependent.
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });

    // Runtime overrides have precedence over persisted OAuth/API credentials and
    // survive runtime provider recomposition. Never log credential values.
    const openrouterKey = process.env.OPENROUTER_API_KEY || this.vmProviderCredentials.get('openrouter')?.apiKey;
    if (openrouterKey) await runtime.setRuntimeApiKey('openrouter', openrouterKey);

    const registry = new ModelRegistry(runtime);
    this.registerCustomModels(registry);
    this.modelRuntime = runtime;
    this.modelRegistry = registry;
    return runtime;
  }

  getModelRegistry(): ModelRegistry {
    if (!this.modelRegistry) {
      throw new Error('Pi ModelRuntime is not initialized. Call and await getModelRuntime() before resolving models.');
    }
    return this.modelRegistry;
  }

  /** Register allowed models from the VM catalog; ignore stale direct-provider rows. */
  private registerCustomModels(registry: ModelRegistry) {
    try {
      const allPi = loadModelsFile().pi || [];
      // VM-local legacy direct providers are never registered, even if enabled.
      const models = allPi.filter(isPiModelEntryEnabledForThisVm);

      // Group by provider (and remember file order for fallback priority)
      const byProvider = new Map<string, any[]>();
      const orderedKeys: Array<{ provider: string; id: string }> = [];
      for (const m of models) {
        const list = byProvider.get(m.provider) || [];
        // Preserve reasoning support for the routed GPT family.
        const isReasoningModel = /^gpt-5/i.test(String(m.modelId)) || m.reasoning === true;
        // ── api kind mapping ───────────────────────────────────────────
        // Pi SDK only registers a fixed set of api kinds (see pi-ai/dist/
        // providers/register-builtins.js): anthropic-messages, openai-completions,
        // openai-responses, azure-openai-responses, mistral-conversations, google-*,
        // bedrock-converse-stream. The `api` field on a model MUST match one of
        // these — otherwise `streamAssistantResponse` throws
        // "No API provider registered for api: <kind>" and `_runLoop` catches it
        // silently via agent_end (no message_end), which used to vanish entirely
        // before the agent_end handler was added (2026-05-16).
        //
        // Provider name (e.g. "openrouter") is NOT a valid api kind on its own —
        // it's just the namespace key. OpenRouter speaks OpenAI Chat Completions,
        // so its api MUST be "openai-completions". Built-in OpenRouter models
        // in pi-ai/dist/models.generated.js confirm this (api: "openai-completions").
        //
        // Mapping table — keep in sync with built-in providers:
        const providerToDefaultApi: Record<string, string> = {
          'openrouter': 'openai-completions',
          'litellm-responses': 'openai-responses',
        };
        // Never accept a VM-local api override that points a permitted namespace
        // at a retired direct provider's SDK transport.
        const resolvedApi = providerToDefaultApi[m.provider];
        if (resolvedApi !== (m.api || m.provider)) {
          console.log(`[Pi] api kind mapped: ${m.provider}/${m.modelId} api="${m.api || m.provider}" → "${resolvedApi}" (built-in provider lookup)`);
        }
        const runtimeModelId = m.modelId;
        const built: any = {
          id: runtimeModelId,
          name: m.name || m.modelId,
          api: resolvedApi,
          // Use a string thinking level (not boolean) so PI SDK's
          // clampThinkingLevel() maps it correctly per model's thinkingLevelMap.
          // Passing `true` falls through to the model's first availableLevel
          // (often 'off' / 'minimal'), which makes reasoning models think
          // unpredictably. Keep reasoning-capable custom models at medium by default;
          // higher/lower effort remains an explicit workload policy choice.
          reasoning: isReasoningModel ? 'medium' : undefined,
          thinkingLevelMap: isReasoningModel
            ? Object.fromEntries(PRODUCT_REASONING_EFFORTS.map(level => [level, m.reasoningEfforts?.includes(level) ? level : null]))
            : undefined,
          input: ['text', 'image'] as ('text' | 'image')[],
          cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          // Catalog rows define the input/output window of each routed model.
          contextWindow: m.contextWindow || 400000,
          maxTokens: m.maxTokens || 128000,
        };
        list.push(built);
        byProvider.set(m.provider, list);
        orderedKeys.push({ provider: m.provider, id: runtimeModelId });
      }
      this.customModelKeys = orderedKeys;

      // Register each allowed provider with its full model set. An invalid
      // connection fails that provider; requested sessions never substitute
      // a different provider or model on registration failure.
      for (const [provider, providerModels] of byProvider) {
        const providerOpts: any = { models: providerModels };
        if (provider === 'openrouter') {
          providerOpts.baseUrl = 'https://openrouter.ai/api/v1';
          providerOpts.apiKey = process.env.OPENROUTER_API_KEY || this.vmProviderCredentials.get(provider)?.apiKey || '';
        } else if (provider === 'litellm-responses') {
          // Self-hosted LiteLLM router using the Responses transport.
          providerOpts.baseUrl = this.vmProviderCredentials.get('litellm-responses')?.baseUrl || '';
          providerOpts.apiKey = this.vmProviderCredentials.get('litellm-responses')?.apiKey || '';
          providerOpts.api = 'openai-responses';
          if (!providerOpts.baseUrl || !providerOpts.apiKey) {
            console.warn('[Pi] Provider "litellm-responses" missing env: LITELLM_BASE_URL or LITELLM_API_KEY — registration will fail.');
          }
        }
        try {
          registry.registerProvider(provider, providerOpts);
          console.log(`[Pi] Registered ${providerModels.length} custom model(s) for provider "${provider}": ${providerModels.map((m: any) => m.id).join(', ')}`);
        } catch (provErr: any) {
          // Strip failed provider models from the fallback list.
          this.customModelKeys = this.customModelKeys.filter((k) => k.provider !== provider);
          console.error(`[Pi] Provider "${provider}" registration FAILED: ${provErr?.message || provErr} — removed from fallback list`);
        }
      }
    } catch (err: any) {
      console.warn(`[Pi] Failed to load custom models: ${err.message}`);
    }
  }

}
