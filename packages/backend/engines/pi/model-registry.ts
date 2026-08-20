// Owns Pi auth storage and custom model registry wiring.
// Public API: PiModelRegistryManager.

import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadModelsFile, isPiModelEntryEnabledForThisVm, getModelDefaults } from '../../config.js';
import { resolveProjectApiKeySecretValue } from '../../services/credential-vault/credential-vault-service.js';
import { allowPiOpenAiDirect } from './provider-safeguards.js';
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
      : provider === 'openai-responses-compatible'
        ? { envName: 'OPENAI_RESPONSES_API_KEY', runtimeProvider: 'openai-responses-compatible' }
        : null;
    if (!target) return [];

    const runtime = await this.getModelRuntime();
    const vmCredential = await resolveConfiguredInferenceProviderSecret(provider, opts.userId);
    if (vmCredential) {
      await runtime.setRuntimeApiKey(target.runtimeProvider, vmCredential.apiKey, { allowNetwork: false });
    }
    if (!opts.projectId) return vmCredential ? [{ provider, credentialId: 'vm-inference-provider' }] : [];

    const resolved = await resolveProjectApiKeySecretValue({
      projectId: opts.projectId,
      userId: opts.userId,
      envName: target.envName,
      targetType: `pi-model-runtime:${provider}`,
    });
    if (!resolved) return vmCredential ? [{ provider, credentialId: 'vm-inference-provider' }] : [];

    await runtime.setRuntimeApiKey(target.runtimeProvider, resolved.value, { allowNetwork: false });
    console.log(`[Pi] Applied Vault API key override for explicit ${provider} session: credential=${resolved.credentialId}`);
    return [{ provider, credentialId: resolved.credentialId }];
  }

  resolvePiModel(modelStr: string): any | null {
    const parts = modelStr.split('/');
    if (parts.length < 2) return null;
    const provider = parts[0];
    const modelId = parts.slice(1).join('/');
    return this.getModelRegistry().find(provider, modelId);
  }

  resolveSessionModel(modelStr?: string): any {
    const registry = this.getModelRegistry();

    if (modelStr) {
      const parts = modelStr.split('/');
      if (parts.length >= 2) {
        const provider = parts[0];
        const modelId = parts.slice(1).join('/');
        const requested = registry.find(provider, modelId);
        if (!requested) {
          throw new Error(
            `Requested Pi model "${modelStr}" not found in registry. ` +
            `Check: (1) models.json has provider/modelId matching, ` +
            `(2) provider registration succeeded (see "[Pi] Provider ... registration FAILED" logs). ` +
            `Refusing silent fallback to a different model.`
          );
        }
        return requested;
      }
    }

    const defaultSpec = getModelDefaults().session;
    const [defaultProvider, ...defaultModelParts] = defaultSpec.split('/');
    const defaultModelId = defaultModelParts.join('/');
    const defaultCandidate = defaultProvider && defaultModelId
      ? registry.find(defaultProvider, defaultModelId)
      : null;
    if (defaultCandidate) {
      console.log(`[Pi] Using configured default model: ${defaultSpec}`);
      return defaultCandidate;
    }

    for (const key of this.getCustomModelKeys()) {
      const candidate = registry.find(key.provider, key.id);
      if (candidate) {
        console.log(`[Pi] Using fallback model (custom): ${key.provider}/${key.id}`);
        return candidate;
      }
    }

    const available = registry.getAvailable();
    if (available.length > 0) {
      const fallback = available[0];
      console.log(`[Pi] Using fallback model (sdk-default): ${fallback.provider}/${fallback.id}`);
      return fallback;
    }

    return undefined;
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
    for (const provider of ['openrouter', 'openai-responses-compatible']) {
      const configured = await resolveConfiguredInferenceProviderSecret(provider, 0);
      if (configured) this.vmProviderCredentials.set(provider, configured);
    }
    // Tower owns its models.json schema and registers the enabled rows below.
    // Disable SDK models.json/network discovery here so an upstream refresh
    // cannot replace Tower's provider routing or make startup network-dependent.
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });

    // Runtime overrides have precedence over persisted OAuth/API credentials and
    // survive runtime provider recomposition. Never log credential values.
    const openrouterKey = process.env.OPENROUTER_API_KEY || this.vmProviderCredentials.get('openrouter')?.apiKey;
    const responsesKey = process.env.OPENAI_RESPONSES_API_KEY || this.vmProviderCredentials.get('openai-responses-compatible')?.apiKey;
    if (openrouterKey) await runtime.setRuntimeApiKey('openrouter', openrouterKey, { allowNetwork: false });
    if (responsesKey) await runtime.setRuntimeApiKey('openai-responses-compatible', responsesKey, { allowNetwork: false });
    if (process.env.ANTHROPIC_API_KEY) {
      await runtime.setRuntimeApiKey('anthropic', process.env.ANTHROPIC_API_KEY, { allowNetwork: false });
    }
    if (process.env.OPENAI_API_KEY && allowPiOpenAiDirect()) {
      await runtime.setRuntimeApiKey('openai', process.env.OPENAI_API_KEY, { allowNetwork: false });
    } else if (process.env.OPENAI_API_KEY) {
      console.log('[Pi] OPENAI_API_KEY present but not injected into Pi direct provider (set PI_ALLOW_OPENAI_DIRECT=1 to opt in).');
    }
    if (process.env.AZURE_OPENAI_API_KEY) {
      await runtime.setRuntimeApiKey('azure-openai-responses', process.env.AZURE_OPENAI_API_KEY, { allowNetwork: false });
    }

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

  /** Resolve Azure region's (baseUrl, apiKey, apiVersion) from an optional region alias.
   *  Default region (no alias) → bare AZURE_OPENAI_BASE_URL / API_KEY / API_VERSION envs.
   *  Region alias e.g. "eastus2" → AZURE_OPENAI_EASTUS2_* envs (uppercased prefix).
   *
   *  Why: gpt-5.5 launched in eastus2 first while koreacentral hosts our 5.4 deployments.
   *  Per-deployment region routing lets each model pick its own region via the optional
   *  `region` field in models.json instead of waiting for koreacentral parity or moving
   *  everything back to eastus2 (which would 10x our RTT for 5.4 calls).
   *  See workspace/decisions/2026-05-15-azure-multi-region-routing.md (TBD).
   */
  resolveAzureRegion(region?: string): { baseUrl: string; apiKey: string; apiVersion: string } {
    const alias = region?.trim().toUpperCase();
    const baseUrl = (alias ? process.env[`AZURE_OPENAI_${alias}_BASE_URL`] : process.env.AZURE_OPENAI_BASE_URL) || '';
    const apiKey  = (alias ? process.env[`AZURE_OPENAI_${alias}_API_KEY`]  : process.env.AZURE_OPENAI_API_KEY)  || '';
    const apiVersion = (alias ? process.env[`AZURE_OPENAI_${alias}_API_VERSION`] : process.env.AZURE_OPENAI_API_VERSION)
      || '2025-03-01-preview';
    return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, apiVersion };
  }

  /** Register custom models from models.json (pi array) so Pi SDK recognizes them.
   *  Single source of truth — same file the frontend reads for model cards
   *  (config.ts loadModelsFile). Removes the old engines/pi-models.json shadow file.
   *  See workspace/decisions/2026-05-15-unified-model-registry.md (TBD).
   */
  private registerCustomModels(registry: ModelRegistry) {
    try {
      const allPi = loadModelsFile().pi || [];
      // Filter to enabled entries only — disabled rows live in the JSON for
      // admin-toggle convenience but must not be wired into the SDK. Some rows
      // are also role-scoped (e.g. full-VM-only Azure emergency path).
      const models = allPi.filter(isPiModelEntryEnabledForThisVm);

      // Group by provider (and remember file order for fallback priority)
      const byProvider = new Map<string, any[]>();
      const orderedKeys: Array<{ provider: string; id: string }> = [];
      for (const m of models) {
        // Some Pi providers are already built into the SDK and include non-API-key
        // OAuth/subscription auth flows. Do NOT re-register them from models.json:
        // ModelRegistry.registerProvider() replaces the provider's model list first,
        // then validates config. Passing a UI-only row without baseUrl/apiKey can wipe
        // the built-in provider. Keep these rows for frontend visibility + fallback
        // ordering only; explicit runs still resolve via registry.find(provider, id).
        if (m.provider === 'openai-codex') {
          orderedKeys.push({ provider: m.provider, id: m.modelId });
          console.log(`[Pi] Using built-in Pi provider model from models.json: ${m.provider}/${m.modelId} (skip custom registration)`);
          continue;
        }
        if (m.provider === 'openai' && !allowPiOpenAiDirect()) {
          console.warn(`[Pi] Skipping OpenAI direct model ${m.provider}/${m.modelId}: PI_ALLOW_OPENAI_DIRECT is not enabled.`);
          continue;
        }

        const list = byProvider.get(m.provider) || [];
        // gpt-5.x family on Azure are reasoning models. Pi SDK only wires the
        // `reasoning: {effort, summary}` request param when `model.reasoning === true`.
        // Leaving this false causes the SDK to fall back to its "force reasoning off"
        // trick ("# Juice: 0 !important" developer message), which correlates with
        // intermittent `response.failed` w/ error=null on Azure.
        // Enable reasoning on gpt-5.x; add more prefixes if new reasoning models land.
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
          'openai-responses-compatible': 'openai-responses',
          'azure-openai-responses': 'azure-openai-responses',
          'anthropic': 'anthropic-messages',
          'openai': 'openai-completions',
        };
        // azure-openai-responses-<region> (예: azure-openai-responses-eastus2) 도
        // builtin api kind 는 azure-openai-responses. provider name suffix 는 region
        // 라우팅 용도일 뿐, SDK 의 API provider 등록은 builtin 그대로 사용.
        // (2026-05-17 multi-region provider namespace 정책)
        if (m.provider.startsWith('azure-openai-responses-')) {
          providerToDefaultApi[m.provider] = 'azure-openai-responses';
        }
        const apiKind = m.api && providerToDefaultApi[m.api]
          // models.json gave a literal api kind — accept only if it's valid (no recursion)
          ? m.api
          : (providerToDefaultApi[m.provider] || m.api || m.provider);
        // Reject legacy/invalid api like literal "openrouter" before SDK throws on it.
        const validApis = new Set([
          'anthropic-messages', 'openai-completions', 'openai-responses',
          'azure-openai-responses', 'mistral-conversations', 'openai-codex-responses',
          'google-generative-ai', 'google-gemini-cli', 'google-vertex',
          'bedrock-converse-stream',
        ]);
        const resolvedApi = validApis.has(apiKind) ? apiKind : (providerToDefaultApi[m.provider] || 'openai-completions');
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
          input: ['text', 'image'] as ('text' | 'image')[],
          cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          // GPT-5 family on Azure officially supports 400K context / 128K output.
          // Using the full ceiling — GPT-5 burns reasoning tokens from the same
          // max_output_tokens budget, so a too-low cap causes silent empty
          // responses (response.failed with no details).
          contextWindow: m.contextWindow || 400000,
          maxTokens: m.maxTokens || 128000,
        };
        // 2026-05-17: 옛 per-model region override (`m.region` + built.headers={'api-key':...})
        // 는 SDK 0.74 의 model.headers 처리 변경으로 무력화됨 (SDK 가 model.headers 를
        // 별도 store 에 저장하지만 OpenAI Node client 의 apiKey 인자에는 provider-level
        // 키만 박힘 → Azure 가 Authorization: Bearer <wrong-region-key> 보내고 401).
        // 대신 provider name suffix (`azure-openai-responses-<region>`) 로 별개 provider
        // 등록 — 아래 byProvider 등록 분기에서 region 별 baseUrl/apiKey 박음.
        // m.region 필드는 backward-compat 용으로 읽기는 하지만 사용 안 함 (provider name 우선).
        list.push(built);
        byProvider.set(m.provider, list);
        orderedKeys.push({ provider: m.provider, id: runtimeModelId });
      }
      this.customModelKeys = orderedKeys;

      // registerProvider replaces ALL models for that provider, so we must
      // include every custom model (not filter out "existing" ones).
      //
      // ⚠️ SDK quirk (model-registry.js:489-494, v0.58.4):
      //   1) `this.models = this.models.filter(m => m.provider !== providerName)`  ← wipes FIRST
      //   2) `if (!config.baseUrl) throw new Error(...)`                            ← THEN validates
      // If we pass `{models, apiKey}` without `baseUrl`, the SDK silently wipes
      // every model for that provider (including its built-ins for "openrouter")
      // before throwing. The outer catch below downgrades the throw to a warning,
      // so the rest of the engine keeps running but `registry.find(provider, id)`
      // returns null for every model we tried to register → fallback to whichever
      // provider was registered first (typically Azure GPT-5.4) → user sees
      // "Kimi K2.6" in the UI but actually talks to GPT-5.4, which then surfaces
      // Azure's "response.failed (no error details)" pattern.
      // Fix: always set baseUrl (OpenRouter has a known public endpoint), and
      // isolate per-provider registration failures so one bad provider can't
      // poison the fallback list with its own keys.
      for (const [provider, providerModels] of byProvider) {
        const providerOpts: any = { models: providerModels };
        if (provider === 'azure-openai-responses') {
          // Default region (no suffix) — bare AZURE_OPENAI_* env.
          providerOpts.baseUrl = process.env.AZURE_OPENAI_BASE_URL || '';
          providerOpts.apiKey = process.env.AZURE_OPENAI_API_KEY || '';
        } else if (provider.startsWith('azure-openai-responses-')) {
          // 2026-05-17 multi-region: region suffix 에서 env prefix 추출.
          // azure-openai-responses-eastus2 → AZURE_OPENAI_EASTUS2_BASE_URL/_API_KEY.
          // SDK 0.74 의 model-level header hack 이 안 통하므로 provider 단위로 분리해야
          // OpenAI Node client 의 apiKey 인자에 정확한 region key 가 박힘.
          const region = provider.substring('azure-openai-responses-'.length);
          const alias = region.toUpperCase();
          providerOpts.baseUrl = process.env[`AZURE_OPENAI_${alias}_BASE_URL`] || '';
          providerOpts.apiKey = process.env[`AZURE_OPENAI_${alias}_API_KEY`] || '';
          // api kind 는 builtin 'azure-openai-responses' — SDK 가 그 streamer 사용.
          providerOpts.api = 'azure-openai-responses';
          if (!providerOpts.baseUrl || !providerOpts.apiKey) {
            console.warn(`[Pi] Provider "${provider}" missing env: AZURE_OPENAI_${alias}_BASE_URL or _API_KEY — registration will fail.`);
          }
        } else if (provider === 'openrouter') {
          providerOpts.baseUrl = (process.env.OPENROUTER_BASE_URL || this.vmProviderCredentials.get(provider)?.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
          providerOpts.apiKey = process.env.OPENROUTER_API_KEY || this.vmProviderCredentials.get(provider)?.apiKey || '';
        } else if (provider === 'openai-responses-compatible') {
          providerOpts.baseUrl = (process.env.OPENAI_RESPONSES_BASE_URL || this.vmProviderCredentials.get(provider)?.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
          providerOpts.apiKey = process.env.OPENAI_RESPONSES_API_KEY || this.vmProviderCredentials.get(provider)?.apiKey || '';
          providerOpts.api = 'openai-responses';
          if (!providerOpts.apiKey) {
            console.warn('[Pi] Provider "openai-responses-compatible" missing env: OPENAI_RESPONSES_API_KEY — registration will fail.');
          }
        } else if (provider === 'litellm-responses') {
          // Tower's in-house self-hosted LiteLLM router (moat-llm-router). Distinct
          // from the external "openai-responses-compatible" wizard path added in
          // d2f07ff2 — that refactor accidentally dropped this branch even though
          // models.json still registers 5 models under this provider and it remains
          // DEFAULT_PI_MODEL_ID. Restored 2026-08-19 after a total pi-session outage.
          providerOpts.baseUrl = (process.env.LITELLM_BASE_URL || '').replace(/\/$/, '');
          providerOpts.apiKey = process.env.LITELLM_API_KEY || '';
          providerOpts.api = 'openai-responses';
          if (!providerOpts.baseUrl || !providerOpts.apiKey) {
            console.warn('[Pi] Provider "litellm-responses" missing env: LITELLM_BASE_URL or LITELLM_API_KEY — registration will fail.');
          }
        }
        try {
          registry.registerProvider(provider, providerOpts);
          console.log(`[Pi] Registered ${providerModels.length} custom model(s) for provider "${provider}": ${providerModels.map((m: any) => m.id).join(', ')}`);
        } catch (provErr: any) {
          // Strip this provider's models from the fallback list so we don't
          // silently route Kimi-tagged sessions to GPT-5.4 etc.
          this.customModelKeys = this.customModelKeys.filter((k) => k.provider !== provider);
          console.error(`[Pi] Provider "${provider}" registration FAILED: ${provErr?.message || provErr} — removed from fallback list`);
        }
      }
    } catch (err: any) {
      console.warn(`[Pi] Failed to load custom models: ${err.message}`);
    }
  }



  resolveAzureDeployment(modelId: string): string {
    const mapStr = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP || '';
    for (const entry of mapStr.split(',')) {
      const [id, deployment] = entry.trim().split('=', 2);
      if (id?.trim() && deployment?.trim() && id.trim() === modelId) return deployment.trim();
    }
    return modelId;
  }
}
