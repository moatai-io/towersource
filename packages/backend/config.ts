import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import { readTeamskillsSkillset } from './services/skill/teamskills-source.js';

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
 * Bootstrap fallback for customer-facing skills materialized into Project Runtime Box.
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

export interface ModelInfo {
  id: string;
  name: string;
  /** Empty string intentionally hides the UI badge. */
  badge: string;
  /** Optional input context window used by frontend context stat line. */
  contextWindow?: number;
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
  /** Optional Tower roles where this model is visible/registered. Omit = all roles. */
  roles?: Array<'full' | 'managed' | 'standalone'>;
  /** Optional: Pi SDK API channel (defaults to provider). */
  api?: string;
  /** Optional: enable reasoning param wiring in Pi SDK (e.g. for thinking models). */
  reasoning?: boolean;
  /** Default Pi thinking level when a run does not provide an explicit effort override. */
  defaultReasoning?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Optional per-million-token rates used by Pi/Tower usage metadata. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Optional: max input context tokens (defaults to 400_000). */
  contextWindow?: number;
  /** Optional: max output tokens (defaults to 128_000). */
  maxTokens?: number;
  /** Optional: Azure region alias for per-model region routing (e.g. "eastus2").
   *  When set, the model's baseUrl/apiKey come from AZURE_OPENAI_<ALIAS>_*
   *  envs instead of the provider default. See pi-engine.ts resolveAzureRegion. */
  region?: string;
}

interface ModelsFile {
  claude: Array<{ id: string; name: string; badge?: string; enabled: boolean; contextWindow?: number }>;
  pi: PiModelEntry[];
  local?: Array<{ id: string; name: string; badge?: string; enabled: boolean; contextWindow?: number }>;
  defaults?: ModelDefaults;
  modelPolicies?: ModelPolicyConfig;
  inferenceProviders?: Record<string, { baseUrl: string; secretName: string; configuredAt: string }>;
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
  fs.writeFileSync(VM_MODELS_JSON_PATH, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
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

export type WorkspaceAppsMode = 'local-metadata' | 'frappe-connector-pilot';

/** Internal-only Workspace Apps / DIY ERP Connector beta. Full operator VM defaults on; self-hosted servers stay off unless explicitly enabled. */
export function isWorkspaceAppsEnabledForVm(role: string | undefined, flag: string | undefined): boolean {
  if (role === 'full') return flag !== 'false';
  return flag === 'true';
}

/** Select which internal 업무 tab implementation to dogfood without deleting the other path. */
export function resolveWorkspaceAppsMode(value: string | undefined): WorkspaceAppsMode {
  return value === 'frappe-connector-pilot' ? 'frappe-connector-pilot' : 'local-metadata';
}

export function isPiModelEntryEnabledForThisVm(m: PiModelEntry): boolean {
  if (m.enabled === false) return false;
  if (!m.roles || m.roles.length === 0) return true;
  const towerRole = (process.env.TOWER_ROLE || 'standalone') as 'full' | 'managed' | 'standalone';
  return m.roles.includes(towerRole);
}

function loadClaudeModels(): ModelInfo[] {
  return loadModelsFile().claude
    .filter(m => m.enabled)
    .map(m => ({ id: m.id, name: m.name, badge: m.badge ?? '', contextWindow: m.contextWindow ?? 200_000 }));
}

function loadPiModels(): ModelInfo[] {
  return loadModelsFile().pi
    .filter(isPiModelEntryEnabledForThisVm)
    .map(m => ({
      id: `pi:${m.provider}/${m.modelId}`,
      name: m.name,
      badge: Object.prototype.hasOwnProperty.call(m, 'badge') ? (m.badge ?? '') : m.provider.toUpperCase().slice(0, 2),
      contextWindow: m.contextWindow ?? 400_000,
    }));
}

function loadLocalModels(): ModelInfo[] {
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

export const DEFAULT_PI_MODEL_ID = 'litellm-responses/smartest';
export const DEFAULT_CLAUDE_MODEL_ID = 'claude-sonnet-4-6';

/**
 * Claude Code models that should be lazily moved to Pi Smartest on the next
 * chat turn, even if Claude itself remains enabled on the VM.
 *
 * Opus 4.8 was a Claude Code subscription-era sticky session model. When the
 * account/model path becomes unusable, leaving existing sessions on
 * `engine=claude` + `model_used=claude-opus-4-8` surfaces a model/account error
 * instead of using Tower's current session default (`litellm-responses/smartest`).
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
 * now the LiteLLM Responses route (`litellm-responses/smartest`). Keeping old rows
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
  // Utility/emergency routes must never become sticky ordinary chat defaults.
  'litellm-responses/mini',
  'azure-openai-responses/gpt-5.4',
  'azure-openai-responses-eastus2/gpt-5.5',
]);

const DEFAULT_MODEL_DEFAULTS: ModelDefaults = {
  session: DEFAULT_PI_MODEL_ID,
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
  const rawDefaults = file.defaults ?? DEFAULT_MODEL_DEFAULTS;
  const result = { ...rawDefaults };

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

  // Pi-only deployments still work: if Claude is disabled and defaults point to
  // Claude, replace them with the first enabled Pi model.
  const piModels = loadPiModels();
  if (!config.claudeEnabled && piModels.length > 0) {
    const fallbackPiModel = piModels[0].id.replace(/^pi:/, '');
    if (isClaudeModelId(result.session)) result.session = fallbackPiModel;
    if (isClaudeModelId(result.ai_reply)) result.ai_reply = fallbackPiModel;
    if (isClaudeModelId(result.ai_task)) result.ai_task = fallbackPiModel;
  }

  return result;
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
    || (model.startsWith('openrouter/') && !ALLOWED_OPENROUTER_EMERGENCY_PI_SESSION_MODELS.has(model))
    || RETIRED_PI_SESSION_MODEL_IDS.has(model);
}

/** Return a safe sticky model for a Pi session, migrating retired/null IDs to the configured default. */
export function normalizePiSessionModelId(model: string | null | undefined): string {
  const piDefault = getModelDefaults().session;
  const normalized = model?.replace(/^pi:/, '');
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
  get workspaceAppsEnabled(): boolean {
    return isWorkspaceAppsEnabledForVm(process.env.TOWER_ROLE, process.env.TOWER_WORKSPACE_APPS_ENABLED);
  },
  get workspaceAppsMode(): WorkspaceAppsMode {
    return resolveWorkspaceAppsMode(process.env.TOWER_WORKSPACE_APPS_MODE);
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

  // AI token budget dashboard (admin-only). The backend SSHs into the central
  // AI router and reads safe /key/info fields from customer key files;
  // key plaintext never leaves the router process stdout.
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

  // Browser/PWA Web Push. VAPID keys are required for real OS-level push;
  // without them the API reports configured=false and the UI stays disabled.
  webPush: {
    publicKey: process.env.WEB_PUSH_PUBLIC_KEY || '',
    privateKey: process.env.WEB_PUSH_PRIVATE_KEY || '',
    subject: process.env.WEB_PUSH_SUBJECT || process.env.PUBLIC_URL || 'mailto:admin@tower.example.com',
  },

  // Customer branding: optional background images served from VM-local paths.
  // These live in .env so customer-specific branding survives Tower code deploys.
  // Example: /home/tower/workspace/brand/logo/png-hires/oku_horizontal_green_light_1500.png
  loginBackgroundImage: process.env.TOWER_LOGIN_BACKGROUND_IMAGE || '',
  appBackgroundImage: process.env.TOWER_APP_BACKGROUND_IMAGE || '',

  // Kakao OAuth / Telegram Bot / outbound messaging kill switch 는
  // #58 (외부 메시징 폐기) Phase 5 에서 제거됨.
  // 근거: workspace/decisions/2026-06-01-external-messaging-removal.md

  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || '',

  // Tower role: determines publishing behavior and feature set
  // 'full'       — Moat AI internal: all features + Publish Gateway server
  // 'managed'    — Self-hosted server: publishes via central Gateway (no local credentials needed)
  // 'standalone' — Self-hosted: customer manages their own Cloudflare/Azure credentials
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
    vmUser: process.env.EXECUTION_VM_USER || 'toweradmin',
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
  // ENABLE_PROJECT_RUNTIME_BOX=true      → mount Pi native tools (project_shell / service_*)
  //                                        for project sessions. Default: false (safe).
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

