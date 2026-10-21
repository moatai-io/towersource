import crypto from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import { readTeamskillsSkillset } from './services/skill/teamskills-source.js';
import { applyDevelopmentGoogleConfig } from './services/auth/development-google-config.js';

// Resolve project root from source file location (not process.cwd())
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dev: packages/backend/config.ts → ../..  |  prod: dist/backend/packages/backend/config.js → ../../../..
const PROJECT_ROOT = __dirname.includes('dist')
  ? path.resolve(__dirname, '..', '..', '..', '..')
  : path.resolve(__dirname, '..', '..');

// Load .env file — provides defaults, inline env vars (from package.json scripts) take precedence
try {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      // Don't override existing env vars (inline vars from dev script take precedence)
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
} catch {}

// Explicit development identity only; production never reads development routing.
applyDevelopmentGoogleConfig(PROJECT_ROOT, process.env);

function findClaudeExecutable(): string {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  let found: string | undefined;

  try {
    const result = execSync('which claude', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) found = result;
  } catch {}

  if (!found) {
    const home = os.homedir();
    const candidates = [
      path.join(home, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/usr/bin/claude',
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) { found = p; break; } } catch {}
    }
  }

  if (!found) {
    return path.join(os.homedir(), '.local', 'bin', 'claude');
  }

  // Resolve symlinks so the Claude Agent SDK sees a path ending in .js/.mjs
  // and spawns it via Node instead of treating it as a native binary.
  // This is critical for npm-global installs where /usr/bin/claude is a
  // symlink to .../cli.js — without resolution, SDK fails to spawn.
  try {
    const resolved = fs.realpathSync(found);
    if (resolved.endsWith('.js') || resolved.endsWith('.mjs')) return resolved;
  } catch {}

  return found;
}

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/**
 * Bootstrap fallback for end-user skills materialized into Project Runtime Box.
 * Runtime defaults should come from teamskills/skillset.json when present.
 * Operators can override with RUNTIME_BOX_MATERIALIZED_SKILLS.
 */
export const DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS = [
  'agents-md',
  'cta',
  'design-explore',
  'design-md',
  'frontend-design',
  'gws',
  'goal',
  'html-slide',
  'ideate',
  'image-slide-gen',
  'issue',
  'md-docx-publisher',
  'mermaid-pdf',
  'naver-search',
  'plan-refine',
  'pdf2pptx',
  'pptx-review',
  'pptx-template',
  'search',
  'session-rename',
  'skill-architect',
  'soul',
  'svg',
  'task-schedule',
  'tiro',
  'tower-intro',
  'web-capture',
  'wiki-compile',
  'youtube-transcript',
] as const;

function parseCsvList(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function parseExperimentalWorkbenchToolProjectIds(value: string | undefined): readonly string[] {
  if (!value) return Object.freeze([] as string[]);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || !item.trim())) return Object.freeze([] as string[]);
    return Object.freeze([...new Set(parsed.map(item => item.trim()))]);
  } catch {
    return Object.freeze([] as string[]);
  }
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelInfo {
  id: string;
  name: string;
  /** Empty string intentionally hides the UI badge. */
  badge: string;
  /** Preset selection is distinct from a direct provider model. */
  kind?: 'policy' | 'direct';
  /** Stable Tower alias label. */
  policyAlias?: 'core' | 'lite';
  /** Runtime model selected by a Tower alias. */
  runtimeModelId?: string;
  /** Optional provider/catalog owner shown as secondary model metadata. */
  provider?: string;
  /** LiteLLM-reported USD per million tokens; absent when unverified. */
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  /** Optional input context window used by frontend context stat line. */
  contextWindow?: number;
  /** Product-supported reasoning values for this exact runtime model. */
  reasoningEfforts?: ReasoningEffort[];
}

/**
 * Per-VM model registry resolution.
 * - TOWER_MODELS_PATH: explicit operator override
 * - data/models.json: writable VM-local registry managed by Admin/setup
 * - packages/backend/models.json: packaged/operator fallback
 */
const PACKAGED_MODELS_JSON_PATH = path.join(PROJECT_ROOT, 'packages', 'backend', 'models.json');
const VM_MODELS_JSON_PATH = process.env.TOWER_MODELS_PATH
  ? path.resolve(process.env.TOWER_MODELS_PATH)
  : path.join(process.env.TOWER_DATA_DIR || process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data'), 'models.json');

export function getModelsConfigPath(): string {
  if (process.env.TOWER_MODELS_PATH) return VM_MODELS_JSON_PATH;
  if (fs.existsSync(VM_MODELS_JSON_PATH)) return VM_MODELS_JSON_PATH;
  return PACKAGED_MODELS_JSON_PATH;
}

export interface ModelDefaults {
  session: string;
  ai_reply: string;
  ai_task: string;
}

export interface ModelPolicyConfig {
  revision: number;
  policies: Record<string, {
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    enabled?: boolean;
    description?: string;
  }>;
}

/**
 * Single source of truth for all engine models. The frontend uses this to
 * render model cards (id/name/badge/enabled), and pi-engine.ts uses the
 * same `pi` array to register custom models with the Pi SDK ModelRegistry
 * (provider/modelId/api/reasoning/contextWindow/maxTokens). Adding a new
 * model = one entry here, no separate engines/pi-models.json sync.
 * See workspace/decisions/2026-05-15-unified-model-registry.md (TBD).
 */
interface PiModelEntry {
  provider: string;
  modelId: string;
  name: string;
  /** Optional badge; set to "" to intentionally hide provider chips in UI. */
  badge?: string;
  enabled: boolean;
  /** Hide from selection without unregistering existing-session support. */
  hidden?: boolean;
  /** Explicit user-picker allow flag. Direct catalog models require true. */
  selectable?: boolean;
  /** Router policy aliases remain distinct from direct models. */
  modelKind?: 'policy' | 'direct';
  discoveredAt?: string;
  lastSeenAt?: string;
  /** Historical compatibility field. Team-scoped /models is now the visibility authority. */
  teamVerifiedAt?: string;
  catalogOwnedBy?: string;
  /** Prices reported by the Team-scoped LiteLLM /models snapshot (USD/token). */
  catalogInputCostPerToken?: number;
  catalogOutputCostPerToken?: number;
  /** Optional Tower roles where this model is visible/registered. Omit = all roles. */
  roles?: Array<'full' | 'managed' | 'standalone'>;
  /** Optional: Pi SDK API channel (defaults to provider). */
  api?: string;
  /** Optional: enable reasoning param wiring in Pi SDK (e.g. for thinking models). */
  reasoning?: boolean;
  /** Default Pi thinking level when a run does not provide an explicit effort override. */
  defaultReasoning?: ReasoningEffort;
  /** Explicit model capability used by UI, API validation, and Pi runtime mapping. */
  reasoningEfforts?: ReasoningEffort[];
  /** Optional per-million-token rates used by Pi/Tower usage metadata. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Optional: max input context tokens (defaults to 400_000). */
  contextWindow?: number;
  /** Optional: max output tokens (defaults to 128_000). */
  maxTokens?: number;
}

interface ModelsFile {
  claude: Array<{ id: string; name: string; badge?: string; enabled: boolean; contextWindow?: number }>;
  pi: PiModelEntry[];
  local?: Array<{ id: string; name: string; badge?: string; enabled: boolean; contextWindow?: number }>;
  defaults?: ModelDefaults;
  modelPolicies?: ModelPolicyConfig;
  inferenceProviders?: Record<string, { baseUrl: string; secretName: string; configuredAt: string }>;
  litellmCatalog?: { syncedAt?: string; syncError?: string };
  /** One-time onboarding provenance; later operator Core/Lite choices stay mutable. */
  customerAiBootstrap?: { version: 1; initializedAt: string; coreModel: string; liteModel: string; visibleModelIds: string[] };
}

/** Exported so pi-engine.ts can register custom models from the same source. */
export type { PiModelEntry };

export function loadModelsFile(): ModelsFile {
  try {
    return JSON.parse(fs.readFileSync(getModelsConfigPath(), 'utf8'));
  } catch {
    return { claude: [], pi: [] };
  }
}

export function saveModelsFile(data: ModelsFile): void {
  // Admin writes always create/update the VM-local registry. Packaged defaults
  // remain immutable so upgrades cannot overwrite a self-hosted VM's choices.
  fs.mkdirSync(path.dirname(VM_MODELS_JSON_PATH), { recursive: true });
  const temporary = `${VM_MODELS_JSON_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, VM_MODELS_JSON_PATH);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function isAgentFirstEnabledForVm(role: string | undefined, flag: string | undefined): boolean {
  // Agent-first is the default product surface for Tower-operated full and
  // self-hosted VMs, both with an explicit false rollback escape hatch. Standalone
  // remains opt-in because its operator owns product-surface decisions.
  if (role === 'full' || role === 'managed') return flag !== 'false';
  if (role === 'standalone') return flag === 'true';
  return false;
}

/** Enable external Agent deployment on Tower-operated Agent-first VMs, with an independent rollback switch. */
export function isAIServiceEnabledForVm(role: string | undefined, agentFirstEnabled: boolean, flag: string | undefined): boolean {
  if (!agentFirstEnabled) return false;
  if (role === 'full' || role === 'managed') return flag !== 'false';
  return role === 'standalone' && flag === 'true';
}

export function isPiModelEntryEnabledForThisVm(m: PiModelEntry): boolean {
  // Retired direct providers must not be exposed by a stale VM-local models.json.
  if (m.enabled === false || !['litellm-responses', 'openrouter'].includes(m.provider)) return false;
  // A stale VM-local registry must not re-register the retired GPT-5.5 router alias.
  if (m.provider === 'litellm-responses' && m.modelId === 'gpt55') return false;
  if (!m.roles || m.roles.length === 0) return true;
  const towerRole = (process.env.TOWER_ROLE || 'standalone') as 'full' | 'managed' | 'standalone';
  return m.roles.includes(towerRole);
}

const CUSTOMER_SELECTABLE_PI_MODELS = new Set<string>();
// These router IDs were retired from the Team allow-list. Keep registry entries
// for historical sessions, but never offer them as new choices.
const RETIRED_ROUTER_MODEL_IDS = new Set(['astra-canary', 'smartest', 'smartest-long', 'sol-fast', 'gpt55']);

function isFullTowerVm(): boolean {
  return process.env.TOWER_ROLE === 'full';
}

export function isPiModelEntrySelectableForThisVm(m: PiModelEntry, catalogSyncedAt?: string): boolean {
  if (!isPiModelEntryEnabledForThisVm(m)) return false;
  if (m.provider === 'litellm-responses') {
    // Core/Lite are Tower labels for the two router aliases used as defaults.
    if (m.modelId === 'mini') return true;
    if (m.modelId === 'smart' || RETIRED_ROUTER_MODEL_IDS.has(m.modelId)) return false;
    // The latest Team-scoped /models snapshot is the visibility authority.
    // Local fields provide metadata only and cannot independently expose a model.
    return !!catalogSyncedAt && m.lastSeenAt === catalogSyncedAt;
  }
  // Explicit Tower direct routes remain local allow-list entries.
  if (m.provider !== 'openrouter' || m.hidden === true) return false;
  if (m.selectable === false) return false;
  if (isFullTowerVm()) return true;
  return CUSTOMER_SELECTABLE_PI_MODELS.has(`${m.provider}/${m.modelId}`);
}

/** Validate a user-originated Pi model choice against the current VM allow-list. */
export function isSelectablePiModelId(model: string | null | undefined): boolean {
  const normalized = model?.replace(/^pi:/, '');
  if (!normalized) return false;
  if (['preset/core', 'preset/lite', 'policy/core', 'policy/lite'].includes(normalized)) {
    const preset = normalized.split('/')[1];
    return loadPiModels().some(entry => entry.id === `pi:preset/${preset}`);
  }
  const file = loadModelsFile();
  return file.pi.some(entry =>
    `${entry.provider}/${entry.modelId}` === normalized && isPiModelEntrySelectableForThisVm(entry, file.litellmCatalog?.syncedAt)
  );
}

function loadClaudeModels(): ModelInfo[] {
  if (!isFullTowerVm()) return [];
  return loadModelsFile().claude
    .filter(m => m.enabled)
    .map(m => ({ id: m.id, name: m.name, badge: m.badge ?? '', contextWindow: m.contextWindow ?? 200_000 }));
}

function loadPiModels(): ModelInfo[] {
  const file = loadModelsFile();
  const defaults = {
    session: file.defaults?.session || DEFAULT_MODEL_DEFAULTS.session,
    ai_task: file.defaults?.ai_task || 'litellm-responses/mini',
  };
  const byId = new Map(file.pi.map(model => [`${model.provider}/${model.modelId}`, model]));
  const prices = (model: PiModelEntry | undefined): Pick<ModelInfo, 'inputPricePerMillion' | 'outputPricePerMillion'> => {
    if (model?.provider !== 'litellm-responses' || model.lastSeenAt !== file.litellmCatalog?.syncedAt) return {};
    if (model.catalogInputCostPerToken === undefined || model.catalogOutputCostPerToken === undefined) return {};
    return {
      inputPricePerMillion: model.catalogInputCostPerToken * 1_000_000,
      outputPricePerMillion: model.catalogOutputCostPerToken * 1_000_000,
    };
  };
  const alias = (policyAlias: 'core' | 'lite', modelId: string): ModelInfo => {
    const model = byId.get(modelId);
    // Keep the selection slot visible even if its VM mapping is missing or
    // disabled. Validation at the execution boundary must reject that mapping.
    return {
      id: `pi:preset/${policyAlias}`,
      name: policyAlias,
      badge: '',
      kind: 'policy',
      policyAlias,
      runtimeModelId: modelId,
      ...prices(model),
      contextWindow: model?.contextWindow ?? 400_000,
      reasoningEfforts: model?.reasoningEfforts,
    };
  };
  const catalogModels = file.pi
    .filter(model => isPiModelEntrySelectableForThisVm(model, file.litellmCatalog?.syncedAt))
    .filter(model => !['smartest', 'mini'].includes(model.modelId))
    .map(model => ({
      id: `pi:${model.provider}/${model.modelId}`,
      name: model.name,
      badge: Object.prototype.hasOwnProperty.call(model, 'badge') ? (model.badge ?? '') : model.provider.toUpperCase().slice(0, 2),
      kind: 'direct' as const,
      provider: model.catalogOwnedBy ?? model.provider,
      ...prices(model),
      contextWindow: model.contextWindow ?? 400_000,
      reasoningEfforts: model.reasoningEfforts,
    }));
  return [alias('core', defaults.session), alias('lite', defaults.ai_task), ...catalogModels];
}

function loadLocalModels(): ModelInfo[] {
  if (!isFullTowerVm()) return [];
  return (loadModelsFile().local || [])
    .filter(m => m.enabled)
    .map(m => ({
      id: `local:${m.id}`,
      name: m.name,
      badge: Object.prototype.hasOwnProperty.call(m, 'badge') ? (m.badge ?? '') : 'LOCAL',
      contextWindow: m.contextWindow,
    }));
}

export let availableModels: ModelInfo[] = loadClaudeModels();

// Session choice, not a physical Router ID. Resolve the current Core mapping at run time.
export const DEFAULT_PI_MODEL_ID = 'preset/core';
export const DEFAULT_CLAUDE_MODEL_ID = 'claude-sonnet-4-6';

/**
 * Claude Code models that should be lazily moved to Pi Core on the next
 * chat turn, even if Claude itself remains enabled on the VM.
 *
 * Opus 4.8 was a Claude Code subscription-era sticky session model. When the
 * account/model path becomes unusable, leaving existing sessions on
 * `engine=claude` + `model_used=claude-opus-4-8` surfaces a model/account error
 * instead of selecting Tower's Core preset.
 */
export const RETIRED_CLAUDE_SESSION_MODEL_IDS = new Set([
  'claude-opus-4-8',
  // Older Opus aliases can still exist in long-lived self-hosted server databases.
  'claude-opus-4-7',
  'claude-opus-4-6',
]);

/**
 * Pi model IDs that should not be inherited/resumed as sticky per-session defaults.
 *
 * These were valid during the Codex/Codex-LB transition, but the session default is
 * now the Core preset. Keeping old rows
 * in `sessions.model_used` makes ordinary follow-up turns silently re-enter direct
 * Codex/OAuth paths and surface auth/fallback noise.
 */
export const RETIRED_PI_SESSION_MODEL_IDS = new Set([
  // Bare Pi aliases were never safe sticky session IDs; provider/model format is required.
  'fast',
  'balanced',
  'smartest',
  'smart',
  'mini',
  // Retired transition-era direct/Chat Completions routes.
  'openai-codex/gpt-5.5',
  'codex-lb/gpt-5.5',
  'litellm/codex-lb-gpt-5.5',
  'litellm/smartest',
  'litellm/smart',
  // Any direct Azure/Codex namespace is retired; historical IDs remain data only.
  'azure-openai-responses/gpt-5.4',
  'azure-openai-responses-eastus2/gpt-5.5',
  'litellm-responses/gpt55',
  'litellm-responses/smartest',
]);

const DEFAULT_MODEL_DEFAULTS: ModelDefaults = {
  session: '', // Missing admin Core mapping must fail readiness, never assume a Router alias
  ai_reply: 'litellm-responses/mini',
  ai_task: 'litellm-responses/mini',
};

function isPiModelId(id: string | undefined): boolean {
  return !!id && id.includes('/');
}

function isClaudeModelId(id: string | undefined): boolean {
  return !!id && id.startsWith('claude-');
}

/** Get admin-configured default models per context, constrained to enabled engines. */
export function getModelDefaults(): ModelDefaults {
  const file = loadModelsFile();
  const result = { ...DEFAULT_MODEL_DEFAULTS, ...file.defaults };
  // Keep VM-scoped router aliases intact. Provider model IDs are not
  // interchangeable with Team-authorized router IDs.

  // Customer/self-hosted VMs are Claude-first unless Pi is explicitly enabled.
  // models.json may carry Pi defaults from the operator VM, so never leak those
  // into /api/config when PI_ENABLED=false.
  const claudeModels = loadClaudeModels();
  if (!config.piEnabled && claudeModels.length > 0) {
    const fallbackClaudeModel = claudeModels[0].id;
    if (isPiModelId(result.session)) result.session = fallbackClaudeModel;
    if (isPiModelId(result.ai_reply)) result.ai_reply = fallbackClaudeModel;
    if (isPiModelId(result.ai_task)) result.ai_task = fallbackClaudeModel;
  }

  // Pi-only deployments with a stale Claude mapping leave Core unavailable.
  // Do not invent a physical Router alias or put a preset into provider defaults.
  if (!config.claudeEnabled) {
    if (isClaudeModelId(result.session)) result.session = DEFAULT_MODEL_DEFAULTS.session;
    if (isClaudeModelId(result.ai_task)) result.ai_task = DEFAULT_MODEL_DEFAULTS.ai_task;
    if (isClaudeModelId(result.ai_reply)) result.ai_reply = result.ai_task || DEFAULT_MODEL_DEFAULTS.ai_reply;
  }

  return result;
}

export function resolveLegacyPiModelId(model: string): string {
  // Preserve allowed router and Kimi selections. A retired direct provider is
  // never translated at the execution boundary; it must fail closed instead.
  return model;
}

export function isRetiredClaudeSessionModelId(model: string | null | undefined): boolean {
  if (!model) return false;
  return RETIRED_CLAUDE_SESSION_MODEL_IDS.has(model);
}

export function shouldAutoMigrateClaudeSessionToPi(input: {
  engine: string | null | undefined;
  model: string | null | undefined;
  claudeEnabled: boolean;
  piEnabled: boolean;
}): boolean {
  if (input.engine !== 'claude' || !input.piEnabled) return false;
  return !input.claudeEnabled || isRetiredClaudeSessionModelId(input.model);
}

const ALLOWED_OPENROUTER_EMERGENCY_PI_SESSION_MODELS = new Set([
  'openrouter/moonshotai/kimi-k2.6',
  'openrouter/moonshotai/kimi-k3',
]);

export function isRetiredPiSessionModelId(model: string | null | undefined): boolean {
  if (!model) return false;
  return model.startsWith('claude-')
    || (!model.startsWith('litellm-responses/') && !ALLOWED_OPENROUTER_EMERGENCY_PI_SESSION_MODELS.has(model))
    || RETIRED_PI_SESSION_MODEL_IDS.has(model);
}

/** Return a safe sticky model for a Pi session, migrating retired/null IDs to the configured default. */
export function normalizePiSessionModelId(model: string | null | undefined): string {
  const piDefault = DEFAULT_PI_MODEL_ID;
  const normalized = model?.replace(/^pi:/, '');
  if (normalized === 'policy/core' || normalized === 'preset/core') return 'preset/core';
  if (normalized === 'policy/lite' || normalized === 'preset/lite') return 'preset/lite';
  // Preserve explicit direct model choices; an ID equal to Core's current
  // mapping does not imply a preset selection.
  if (!normalized || !normalized.includes('/') || isRetiredPiSessionModelId(normalized)) return piDefault;
  return normalized;
}

/** Reload models from JSON file — call after admin edits.
 *  Note: config.piModels is now a getter that reads fresh each call, so we
 *  don't need to refresh it here. Claude/local still cache at startup.
 */
export function reloadModels(): { claude: ModelInfo[]; pi: ModelInfo[]; local: ModelInfo[]; defaults: ModelDefaults } {
  availableModels = loadClaudeModels();
  config.localModels = loadLocalModels();
  return { claude: availableModels, pi: config.piModels, local: config.localModels, defaults: getModelDefaults() };
}

function normalizePublicUrl(url: string): string {
  return url.replace(/\/$/, '');
}

function resolvePublicUrl(): string {
  return process.env.PUBLIC_URL ? normalizePublicUrl(process.env.PUBLIC_URL) : '';
}

export function resolveSharePublicUrl(publicUrl: string): string {
  // OSS has no knowledge of an operator's canonical domain or aliases.
  // Deployments that need a distinct share host must set SHARE_PUBLIC_URL.
  return publicUrl;
}

const resolvedPublicUrl = resolvePublicUrl();
const resolvedSharePublicUrl = process.env.SHARE_PUBLIC_URL
  ? normalizePublicUrl(process.env.SHARE_PUBLIC_URL)
  : resolveSharePublicUrl(resolvedPublicUrl);

export const config = {
  port: parseInt(process.env.PORT || '32354'),
  host: process.env.HOST || '0.0.0.0',

  // Claude SDK
  claudeExecutable: findClaudeExecutable(),
  defaultCwd: process.env.DEFAULT_CWD || process.cwd(),
  permissionMode: (process.env.PERMISSION_MODE || 'bypassPermissions') as PermissionMode,

  // Concurrency
  // 2026-04-10 (100-user scale): default raised 30 → 50 so that up to half of
  // a 100-user team can have an active Claude session running simultaneously.
  maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '50'),

  // Auth
  jwtSecret: process.env.JWT_SECRET || 'tower-secret-change-me',
  authEnabled: process.env.NO_AUTH !== 'true',
  tokenExpiry: '90d',

  // File system
  workspaceRoot: process.env.WORKSPACE_ROOT || os.homedir(),
  hiddenPatterns: ['.git', 'node_modules', '__pycache__', '.venv', '.env', '.DS_Store'],

  // Data directory for local files (skills cache etc).
  // The primary DB is PostgreSQL (DATABASE_URL) — this is NOT a DB path.
  // Historically named `dbPath` during the SQLite era; renamed 2026-04-21.
  dataDir: process.env.TOWER_DATA_DIR || process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data'),

  // Sandbox (Linux only, requires: apt install bubblewrap)
  sandboxEnabled: process.env.SANDBOX_ENABLED === 'true',

  // Fleet remote exec — disabled by default. See TWR-03 (2026-04-28).
  // The substring blocklist in remoteExec is trivially bypassable, and a
  // JWT_SECRET leak chains directly into self-hosted-server takeover via this
  // endpoint. Pending command-catalog redesign (medium-term).
  fleetExecEnabled: process.env.FLEET_EXEC_ENABLED === 'true',

  // Git auto-commit — opt-in only. Uploads never auto-commit; this flag is
  // reserved for AI/code edit flows that explicitly want git audit commits.
  // See workspace/decisions/2026-06-08-large-folder-resumable-upload.md.
  gitAutoCommit: process.env.GIT_AUTO_COMMIT === 'true',

  // Agent-first / AI talent team product surface. Full and self-hosted VMs enable
  // it by default with an explicit false rollback escape hatch. Standalone VMs
  // stay off unless TOWER_AGENT_FIRST_ENABLED=true is explicit.
  agentFirstEnabled: isAgentFirstEnabledForVm(process.env.TOWER_ROLE, process.env.TOWER_AGENT_FIRST_ENABLED),
  get aiServicesEnabled(): boolean {
    return isAIServiceEnabledForVm(process.env.TOWER_ROLE, this.agentFirstEnabled, process.env.TOWER_AI_SERVICES_ENABLED);
  },

  // Internal-only managed Workbench tool revision PoC. Disabled by default.
  experimentalWorkbenchTools: Object.freeze({
    get enabled(): boolean { return process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED === 'true'; },
    get projectIds(): readonly string[] { return parseExperimentalWorkbenchToolProjectIds(process.env.TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS); },
    get storeRoot(): string {
      return path.resolve(
        process.env.TOWER_WORKBENCH_TOOL_STORE_ROOT
        || path.join(process.env.TOWER_DATA_DIR || process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data'), 'runtime-box', 'workbench-tools'),
      );
    },
  }),

  // File preview AI inline edit — default off. This keeps the preserved
  // inline-edit module available for dogfooding without exposing the UI/API
  // on normal customer deployments.
  inlineEditEnabled: process.env.INLINE_EDIT_ENABLED === 'true',

  // Turn Rewind is enabled by default across Tower-operated fleet once the
  // split 158/159 migration structure is approved. Set explicitly to false as
  // a rollback/defer hatch for a VM that has not yet scheduled the migrations.
  turnRewindEnabled: process.env.TOWER_TURN_REWIND_ENABLED !== 'false',

  // Source-backed cursor editing in Markdown/HTML previews. Default on across
  // all VM roles; set PREVIEW_DIRECT_EDIT_ENABLED=false to temporarily disable.
  previewDirectEditEnabled: process.env.PREVIEW_DIRECT_EDIT_ENABLED !== 'false',

  // Engine
  // Pi is the default engine. Claude is archived and only available behind an
  // explicit break-glass flag, so DEFAULT_ENGINE=claude is no longer a safe
  // implicit fallback.
  defaultEngine: process.env.DEFAULT_ENGINE || 'pi',

  // AI token budget dashboard (admin-only). Budget and usage identity come
  // from this VM's active LiteLLM virtual key. Router-admin SpendLogs are used
  // only when explicitly configured; otherwise local usage is bounded by the
  // current key's created_at so previous shared-key turns are not misattributed.
  litellmRouterSshTarget: process.env.LITELLM_ROUTER_SSH_TARGET || '',
  litellmRouterDir: process.env.LITELLM_ROUTER_DIR || '/opt/tower-llm-router',
  claudeEnabled: process.env.TOWER_ENABLE_ARCHIVED_CLAUDE_ENGINE === 'true' && process.env.CLAUDE_ENABLED === 'true',
  piEnabled: process.env.PI_ENABLED !== 'false',
  // Getter: fresh-read on every access. Source of truth = models.json (pi array).
  // No restart needed when adding/toggling Pi models — saves the "config.piModels
  // startup snapshot" footgun (see 2026-05-15 unified-registry refactor).
  get piModels(): ModelInfo[] { return loadPiModels(); },
  localEnabled: process.env.LOCAL_LLM_ENABLED === 'true',
  localModels: loadLocalModels(),
  localLlmBaseUrl: process.env.LOCAL_LLM_BASE_URL || 'http://localhost:8080',
  localLlmApiKey: process.env.LOCAL_LLM_API_KEY || '',
  localLlmDefaultModel: process.env.LOCAL_LLM_DEFAULT_MODEL || '',

  // Frontend (for production)
  frontendDir: path.join(PROJECT_ROOT, 'dist', 'frontend'),

  // Public URL — used for generating shareable links (e.g. https://your-domain.example.com)
  // If not set, share links use window.location.origin (fallback, can be wrong domain)
  publicUrl: resolvedPublicUrl,
  sharePublicUrl: resolvedSharePublicUrl,
  // Explicit separate-origin path Publishing. Unset preserves legacy subdomain URLs.
  publishingBaseUrl: process.env.TOWER_PUBLISHING_BASE_URL || undefined,

  // Browser/PWA Web Push. VAPID keys are required for real OS-level push;
  // without them the API reports configured=false and the UI stays disabled.
  webPush: {
    publicKey: process.env.WEB_PUSH_PUBLIC_KEY || '',
    privateKey: process.env.WEB_PUSH_PRIVATE_KEY || '',
    subject: process.env.WEB_PUSH_SUBJECT || process.env.PUBLIC_URL || 'mailto:admin@tower.example.com',
  },

  // Organization branding: optional background images served from VM-local paths.
  // These live in .env so deployment-specific branding survives Tower upgrades.
  // Example: /home/tower/workspace/brand/login-background.png
  loginBackgroundImage: process.env.TOWER_LOGIN_BACKGROUND_IMAGE || '',
  appBackgroundImage: process.env.TOWER_APP_BACKGROUND_IMAGE || '',

  // Kakao OAuth / Telegram Bot / outbound messaging kill switch 는
  // #58 (외부 메시징 폐기) Phase 5 에서 제거됨.
  // 근거: workspace/decisions/2026-06-01-external-messaging-removal.md

  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || '',

  // Deployment profile: determines publishing behavior and operator-only surfaces.
  // 'full'       — Organization control plane: all product features + Publish Gateway server.
  // 'managed'    — Self-hosted node connected to an explicitly configured operator gateway.
  // 'standalone' — Independent self-host (default): no external operator dependency.
  towerRole: (process.env.TOWER_ROLE || 'standalone') as 'full' | 'managed' | 'standalone',

  // Publish Gateway (managed mode only)
  publishGatewayUrl: process.env.PUBLISH_GATEWAY_URL || '',
  publishApiKey: process.env.PUBLISH_API_KEY || '',

  // ── Execution Sandbox (Phase 1, optional, Full only) ──────────────────
  // Decision: workspace/decisions/2026-04-24-execution-sandbox-scope.md (D8)
  // Plan:     tower/docs/plans/2026-04-26-execution-sandbox-phase1.md (1a)
  // Each Tower instance has a 1:1 mapped execution VM. Empty vmHost → feature off.
  sandbox: {
    enabled: process.env.ENABLE_SANDBOX === 'true',
    vmHost: process.env.EXECUTION_VM_HOST || '',         // ssh config alias or IP
    vmUser: process.env.EXECUTION_VM_USER || 'tower-user',
    vmKeyPath: process.env.EXECUTION_VM_KEY_PATH || '',  // empty → ssh-agent / default key
    sshTimeoutSec: parseInt(process.env.EXECUTION_VM_SSH_TIMEOUT || '15', 10),
    // 멀티유저 보호 (2026-05-03):
    //   - globalConcurrencyCap: 전체 동시 실행 cap (B1ms 기준 8 권장)
    //   - perUserConcurrencyCap: 사용자당 cap (기본 2, sandbox.ts default)
    //   - memberWorkspacePrefixes: member 이하 사용자가 Mode B 로 마운트 가능한
    //     workspace 경로 prefix (admin/operator 는 무제한). 콤마 구분.
    globalConcurrencyCap: parseInt(process.env.SANDBOX_GLOBAL_CONCURRENCY_CAP || '8', 10),
    memberWorkspacePrefixes: (process.env.SANDBOX_MEMBER_WORKSPACE_PREFIXES || 'sandbox-tools/,projects/')
      .split(',').map(s => s.trim()).filter(Boolean),
    // Secret store (Q12) — AES-GCM 256 master key, 64 hex chars (32 bytes).
    // Generate: openssl rand -hex 32
    // Empty → secret_store features 비활성. sandbox 일반 실행은 영향 없음.
    secretStoreMasterKey: process.env.SECRET_STORE_MASTER_KEY || '',
  },

  // ── Project Runtime Box ──────────────────────────────────────────────────
  // Per-project persistent container that gives users a local-dev feel inside
  // their Tower project (Terminal + IDE + Process panel + Browser metaphor).
  //
  // Decision: workspace/decisions/2026-06-02-project-runtime-box-product-framing.md
  //
  // ENABLE_PROJECT_RUNTIME_BOX=true      → mount Project execution tools for project sessions.
  //                                        This legacy-named master switch covers Worker-first and
  //                                        Runtime Box compatibility execution. Default: false (safe).
  // ENABLE_RUNTIME_BOX_COMPATIBILITY=false → keep Worker-first execution but refuse local Runtime Box
  //                                        fallback for unbound Projects. Defaults to the master switch
  //                                        for backward compatibility when unset.
  // RUNTIME_BOX_EXCLUDED_PROJECTS        → comma-separated project IDs or names that
  //                                        must NOT get Runtime Box tools mounted.
  //                                        Example: tower,_team,admin
  //                                        Tower core and _team are recommended defaults.
  // RUNTIME_BOX_DEFAULT_MEMORY_MB        → default per-box memory limit. Default 3072 (3GB).
  // RUNTIME_BOX_MAX_MEMORY_MB            → hard cap per box, including DB rows. Default 3072.
  // RUNTIME_BOX_MAX_RUNNING              → global cap on concurrently running boxes.
  //                                        Default 8. Exceeding → RuntimeBoxError.
  // RUNTIME_BOX_MAX_RUNNING_PER_USER     → per-user cap (by created_by).
  //                                        Default 5.
  runtimeBox: {
    enabled: process.env.ENABLE_PROJECT_RUNTIME_BOX === 'true',
    compatibilityEnabled: process.env.ENABLE_RUNTIME_BOX_COMPATIBILITY === undefined
      ? process.env.ENABLE_PROJECT_RUNTIME_BOX === 'true'
      : process.env.ENABLE_RUNTIME_BOX_COMPATIBILITY === 'true',
    excludedProjects: (process.env.RUNTIME_BOX_EXCLUDED_PROJECTS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    defaultMemoryMb: parseInt(process.env.RUNTIME_BOX_DEFAULT_MEMORY_MB || '3072', 10),
    maxMemoryMb: parseInt(process.env.RUNTIME_BOX_MAX_MEMORY_MB || '3072', 10),
    maxRunning: parseInt(process.env.RUNTIME_BOX_MAX_RUNNING || '8', 10),
    maxRunningPerUser: parseInt(process.env.RUNTIME_BOX_MAX_RUNNING_PER_USER || '5', 10),
    // Docker image — 이 이미지가 없으면 docker run 이 RuntimeBoxError 반환.
    // Phase 1 이미지 (node22 + python313 + git + npm + pip):
    //   docker build -t tower-runtime-box:node22-python313 packages/backend/sandbox-images/runtime-box-node22-python313/
    // Operator profile image:
    //   docker build --build-arg BASE_IMAGE=tower-runtime-box:node22-python313 \
    //     -t tower-runtime-box:operator-tools packages/backend/sandbox-images/runtime-box-operator-tools/
    image: process.env.RUNTIME_BOX_IMAGE || 'tower-runtime-box:node22-python313',
    // Docker 바이너리 경로. 기본 'docker'. PATH 에 없으면 절대경로 지정.
    dockerBin: process.env.RUNTIME_BOX_DOCKER_BIN || 'docker',
    // Project-scoped skill materialization (2026-06-09; teamskills-first 2026-06-24).
    // Off unless explicitly enabled. Operators can override with a comma-separated
    // RUNTIME_BOX_MATERIALIZED_SKILLS. Otherwise read teamskills/skillset.json,
    // falling back to DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS only for bootstrap/test compatibility.
    materializeSkills: process.env.RUNTIME_BOX_MATERIALIZE_SKILLS === 'true',
    materializedSkillNames: process.env.RUNTIME_BOX_MATERIALIZED_SKILLS?.trim()
      ? parseCsvList(process.env.RUNTIME_BOX_MATERIALIZED_SKILLS)
      : readTeamskillsSkillset(DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS),
  },

  // Server epoch — changes on each restart, used to detect server restarts
  serverEpoch: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
};

export function validateConfig() {
  const INSECURE = ['tower-secret-change-me', 'change-me-to-a-random-secret', ''];
  if (config.authEnabled && INSECURE.includes(config.jwtSecret)) {
    console.error('\n[FATAL] JWT_SECRET is not set or uses the default placeholder.');
    console.error('  Run: openssl rand -hex 32');
    console.error('  Then set JWT_SECRET in .env\n');
    process.exit(1);
  }

  // Log tower role
  console.log(`[config] TOWER_ROLE=${config.towerRole}`);
  if (config.towerRole === 'managed' && !config.publishGatewayUrl) {
    console.warn('[config] TOWER_ROLE=managed but PUBLISH_GATEWAY_URL is not set. External publishing will be unavailable.');
  }
}

export function getPermissionMode(role?: string): PermissionMode {
  // 1:1 session permission mode — see decisions/2026-05-04-five-role-model.md
  // (room/channel uses a separate path: getRoomTaskPermissionMode in ai-dispatch.ts)
  switch (role) {
    case 'admin':    return 'bypassPermissions';
    case 'operator': return 'bypassPermissions';
    case 'member':   return 'acceptEdits';
    case 'guest':    return 'acceptEdits'; // member 와 동일 — 도구 권한 같음
    case 'viewer':   return 'plan';
    case 'user':     return 'acceptEdits'; // legacy backward-compat
    default:         return config.permissionMode;
  }
}

