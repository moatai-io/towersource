/**
 * app-settings.ts — small typed key/value settings for workspace-level policy.
 *
 * Owns: app_settings reads/writes.
 * Public API: signup approval mode and AI composer autocomplete settings helpers.
 */
import { execute, queryOne } from '../../db/pg-repo.js';

export type SignupApprovalMode = 'auto' | 'manual';
export type ResponseLanguage = 'en' | 'ko';

export const SIGNUP_APPROVAL_MODES: ReadonlySet<SignupApprovalMode> = new Set(['auto', 'manual']);
export const RESPONSE_LANGUAGES: ReadonlySet<ResponseLanguage> = new Set(['en', 'ko']);
const SIGNUP_APPROVAL_MODE_KEY = 'signup.approval_mode';
const DEFAULT_RESPONSE_LANGUAGE_KEY = 'language.default_response';
const AI_COMPOSER_SETTINGS_KEY = 'ai.composer_autocomplete';

export interface AiComposerSettings {
  enabled: boolean;
  emptyDraftEnabled: boolean;
  inlineDraftEnabled: boolean;
  debounceMs: number;
  minRequestIntervalMs: number;
  responseMaxAgeMs: number;
  minDraftLength: number;
  assistantContextChars: number;
  modelTimeoutMs: number;
}

export const DEFAULT_AI_COMPOSER_SETTINGS: AiComposerSettings = {
  enabled: true,
  emptyDraftEnabled: true,
  inlineDraftEnabled: false,
  debounceMs: 500,
  minRequestIntervalMs: 5_000,
  responseMaxAgeMs: 5_000,
  minDraftLength: 4,
  assistantContextChars: 100,
  modelTimeoutMs: 10_000,
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function normalizeAiComposerSettings(value: unknown): AiComposerSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AI_COMPOSER_SETTINGS.enabled,
    emptyDraftEnabled: typeof raw.emptyDraftEnabled === 'boolean' ? raw.emptyDraftEnabled : DEFAULT_AI_COMPOSER_SETTINGS.emptyDraftEnabled,
    inlineDraftEnabled: typeof raw.inlineDraftEnabled === 'boolean' ? raw.inlineDraftEnabled : DEFAULT_AI_COMPOSER_SETTINGS.inlineDraftEnabled,
    debounceMs: boundedNumber(raw.debounceMs, DEFAULT_AI_COMPOSER_SETTINGS.debounceMs, 100, 10_000),
    minRequestIntervalMs: boundedNumber(raw.minRequestIntervalMs, DEFAULT_AI_COMPOSER_SETTINGS.minRequestIntervalMs, 0, 60_000),
    responseMaxAgeMs: boundedNumber(raw.responseMaxAgeMs, DEFAULT_AI_COMPOSER_SETTINGS.responseMaxAgeMs, 500, 30_000),
    minDraftLength: boundedNumber(raw.minDraftLength, DEFAULT_AI_COMPOSER_SETTINGS.minDraftLength, 1, 100),
    assistantContextChars: boundedNumber(raw.assistantContextChars, DEFAULT_AI_COMPOSER_SETTINGS.assistantContextChars, 0, 2_000),
    modelTimeoutMs: boundedNumber(raw.modelTimeoutMs, DEFAULT_AI_COMPOSER_SETTINGS.modelTimeoutMs, 1_000, 30_000),
  };
}

/** Return live VM-wide AI composer settings from PostgreSQL. */
export async function getAiComposerSettings(): Promise<AiComposerSettings> {
  const row = await queryOne<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [AI_COMPOSER_SETTINGS_KEY]);
  return normalizeAiComposerSettings(row?.value);
}

/** Validate and persist live VM-wide AI composer settings. */
export async function setAiComposerSettings(value: unknown, updatedBy?: number | null): Promise<AiComposerSettings> {
  const settings = normalizeAiComposerSettings(value);
  await execute(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [AI_COMPOSER_SETTINGS_KEY, JSON.stringify(settings), updatedBy ?? null],
  );
  return settings;
}

function normalizeResponseLanguage(value: unknown): ResponseLanguage | null {
  return typeof value === 'string' && RESPONSE_LANGUAGES.has(value as ResponseLanguage)
    ? value as ResponseLanguage
    : null;
}

/** Return the Admin Panel response-language default, or null to use the VM bootstrap fallback. */
export async function getDefaultResponseLanguage(): Promise<ResponseLanguage | null> {
  const row = await queryOne<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [DEFAULT_RESPONSE_LANGUAGE_KEY]);
  return normalizeResponseLanguage(row?.value);
}

/** Validate and persist the Admin Panel response-language default. */
export async function setDefaultResponseLanguage(language: unknown, updatedBy?: number | null): Promise<ResponseLanguage> {
  const normalized = normalizeResponseLanguage(language);
  if (!normalized) throw new Error(`Invalid response language: ${String(language)}`);
  await execute(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [DEFAULT_RESPONSE_LANGUAGE_KEY, JSON.stringify(normalized), updatedBy ?? null],
  );
  return normalized;
}

function normalizeSignupApprovalMode(value: unknown): SignupApprovalMode {
  return value === 'manual' ? 'manual' : 'auto';
}

/** Return whether invite-code signup activates immediately or waits for admin approval. */
export async function getSignupApprovalMode(): Promise<SignupApprovalMode> {
  const row = await queryOne<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [SIGNUP_APPROVAL_MODE_KEY],
  );
  return normalizeSignupApprovalMode(row?.value);
}

/** Set invite-code signup approval mode. */
export async function setSignupApprovalMode(mode: SignupApprovalMode, updatedBy?: number | null): Promise<SignupApprovalMode> {
  if (!SIGNUP_APPROVAL_MODES.has(mode)) {
    throw new Error(`Invalid signup approval mode: ${mode}`);
  }
  await execute(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [SIGNUP_APPROVAL_MODE_KEY, JSON.stringify(mode), updatedBy ?? null],
  );
  return mode;
}
