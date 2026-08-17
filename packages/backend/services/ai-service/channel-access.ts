import crypto from 'node:crypto';
import { queryOne } from '../../db/pg-repo.js';
import { ChannelCredentialError } from './channel-credential.js';

export type AIServiceChannelAccessMode = 'public' | 'unlisted' | 'password' | 'login_required' | 'disabled';

export interface ChannelPublicUiConfig {
  showInfoPanel: boolean;
  showTools: boolean;
  showMaterials: boolean;
  showTiming: boolean;
}

export interface ChannelAccessConfig {
  mode: AIServiceChannelAccessMode;
  hasPassword: boolean;
  ui: ChannelPublicUiConfig;
}

interface ChannelAccessRow {
  config: Record<string, unknown> | null;
}

const MODES = new Set<AIServiceChannelAccessMode>(['public', 'unlisted', 'password', 'login_required', 'disabled']);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicAccess(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const root = object(config || {});
  return object(root.publicAccess || {});
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function publicUi(access: Record<string, unknown>): ChannelPublicUiConfig {
  const ui = object(access.ui);
  return {
    showInfoPanel: bool(ui.showInfoPanel, true),
    showTools: bool(ui.showTools, true),
    showMaterials: bool(ui.showMaterials, true),
    showTiming: bool(ui.showTiming, true),
  };
}

export function channelAccessFromConfig(config: Record<string, unknown> | null | undefined): ChannelAccessConfig {
  const access = publicAccess(config);
  const raw = typeof access.mode === 'string' ? access.mode : typeof (config as Record<string, unknown> | null | undefined)?.accessMode === 'string' ? String((config as Record<string, unknown>).accessMode) : 'unlisted';
  const mode = MODES.has(raw as AIServiceChannelAccessMode) ? raw as AIServiceChannelAccessMode : 'unlisted';
  return { mode, hasPassword: typeof access.passwordHash === 'string' && typeof access.passwordSalt === 'string', ui: publicUi(access) };
}

function hashPassword(password: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

export function buildPublicAccessConfig(input: { mode: string; password?: string; existing?: Record<string, unknown> | null; ui?: Partial<ChannelPublicUiConfig> }): Record<string, unknown> {
  if (!MODES.has(input.mode as AIServiceChannelAccessMode)) throw new ChannelCredentialError('invalid access mode', 400);
  const mode = input.mode as AIServiceChannelAccessMode;
  const current = publicAccess(input.existing);
  const next: Record<string, unknown> = { ...current, mode, ui: { ...publicUi(current), ...(input.ui || {}) } };
  if (mode === 'password') {
    const password = typeof input.password === 'string' ? input.password.trim() : '';
    if (password) {
      const salt = crypto.randomBytes(16).toString('hex');
      next.passwordSalt = salt;
      next.passwordHash = hashPassword(password, salt);
    } else if (typeof current.passwordSalt === 'string' && typeof current.passwordHash === 'string') {
      next.passwordSalt = current.passwordSalt;
      next.passwordHash = current.passwordHash;
    } else {
      throw new ChannelCredentialError('password required for password access mode', 400);
    }
  } else {
    delete next.passwordSalt;
    delete next.passwordHash;
  }
  return next;
}

export async function getChannelAccessConfig(input: { serviceId: string; channelId: string }): Promise<ChannelAccessConfig> {
  const row = await queryOne<ChannelAccessRow>('SELECT config FROM ai_service_channels WHERE id=$1 AND service_id=$2', [input.channelId, input.serviceId]);
  if (!row) throw new ChannelCredentialError('AI Service Channel not found', 404);
  return channelAccessFromConfig(row.config);
}

export async function updateChannelAccessConfig(input: { serviceId: string; channelId: string; mode: string; password?: string; ui?: Partial<ChannelPublicUiConfig> }): Promise<ChannelAccessConfig> {
  const row = await queryOne<ChannelAccessRow>('SELECT config FROM ai_service_channels WHERE id=$1 AND service_id=$2', [input.channelId, input.serviceId]);
  if (!row) throw new ChannelCredentialError('AI Service Channel not found', 404);
  const next = buildPublicAccessConfig({ mode: input.mode, password: input.password, existing: row.config, ui: input.ui });
  const updated = await queryOne<ChannelAccessRow>(
    `UPDATE ai_service_channels
        SET config=jsonb_set(COALESCE(config,'{}'::jsonb), '{publicAccess}', $3::jsonb, true), updated_at=NOW()
      WHERE id=$1 AND service_id=$2
      RETURNING config`,
    [input.channelId, input.serviceId, JSON.stringify(next)],
  );
  if (!updated) throw new ChannelCredentialError('AI Service Channel not found', 404);
  return channelAccessFromConfig(updated.config);
}

export function assertPublicSiteAccess(input: { config: Record<string, unknown> | null | undefined; password?: string; allowMetadata?: boolean }): ChannelAccessConfig {
  const access = channelAccessFromConfig(input.config);
  if (input.allowMetadata) return access;
  if (access.mode === 'disabled') throw new ChannelCredentialError('AI Service website is disabled', 403);
  if (access.mode === 'login_required') throw new ChannelCredentialError('Login required for this AI Service website', 401);
  if (access.mode === 'password') {
    const raw = publicAccess(input.config);
    const password = typeof input.password === 'string' ? input.password : '';
    if (!password || typeof raw.passwordSalt !== 'string' || typeof raw.passwordHash !== 'string' || hashPassword(password, raw.passwordSalt) !== raw.passwordHash) {
      throw new ChannelCredentialError('AI Service website password required', 401);
    }
  }
  return access;
}

export async function assertChannelServingAccess(input: { serviceId: string; channelId: string }): Promise<ChannelAccessConfig> {
  const access = await getChannelAccessConfig(input);
  if (access.mode === 'disabled') throw new ChannelCredentialError('AI Service Channel is disabled', 403);
  return access;
}
