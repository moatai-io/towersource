/**
 * Owns: Runtime Box host capacity recommendations and live admin overrides.
 * Public API: getRuntimeBoxCapacity, updateRuntimeBoxCapacity, initializeRuntimeBoxCapacity.
 * See services/runtime-box/README.md.
 */
import os from 'os';
import { config } from '../../config.js';
import { execute, queryOne } from '../../db/pg-repo.js';

const SETTINGS_KEY = 'runtime_box.capacity';

export type RuntimeBoxCapacitySettings = {
  maxRunning: number;
  maxRunningPerUser: number;
};

type StoredCapacity = Partial<RuntimeBoxCapacitySettings>;

let liveSettings: RuntimeBoxCapacitySettings = {
  maxRunning: config.runtimeBox.maxRunning,
  maxRunningPerUser: config.runtimeBox.maxRunningPerUser,
};

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function normalize(value: StoredCapacity | null | undefined): RuntimeBoxCapacitySettings {
  return {
    maxRunning: Number.isInteger(value?.maxRunning) && Number(value?.maxRunning) > 0 ? Number(value?.maxRunning) : config.runtimeBox.maxRunning,
    maxRunningPerUser: Number.isInteger(value?.maxRunningPerUser) && Number(value?.maxRunningPerUser) > 0 ? Number(value?.maxRunningPerUser) : config.runtimeBox.maxRunningPerUser,
  };
}

/** Return the limits used immediately by admission checks. */
export function getLiveRuntimeBoxCapacity(): RuntimeBoxCapacitySettings {
  return { ...liveSettings };
}

/** Load persisted limits after PostgreSQL initialization. */
export async function initializeRuntimeBoxCapacity(): Promise<RuntimeBoxCapacitySettings> {
  const row = await queryOne<{ value: StoredCapacity }>('SELECT value FROM app_settings WHERE key = $1', [SETTINGS_KEY]);
  liveSettings = normalize(row?.value);
  return getLiveRuntimeBoxCapacity();
}

/** Return host specs, conservative recommendations, and current live limits. */
export async function getRuntimeBoxCapacity() {
  await initializeRuntimeBoxCapacity();
  const cpuThreads = Math.max(1, os.cpus().length);
  const totalMemoryMb = Math.round(os.totalmem() / 1024 / 1024);
  const boxMemoryMb = Math.max(1, config.runtimeBox.maxMemoryMb);
  const memorySafeBoxes = Math.max(1, Math.floor((totalMemoryMb * 0.7) / boxMemoryMb));
  const cpuSafeBoxes = Math.max(1, cpuThreads * 2);
  const recommendedMaxRunning = Math.max(1, Math.min(memorySafeBoxes, cpuSafeBoxes));
  const recommendedMaxRunningPerUser = Math.max(1, Math.min(5, recommendedMaxRunning));
  return {
    host: { cpuThreads, totalMemoryMb },
    box: { maxMemoryMb: boxMemoryMb },
    recommended: { maxRunning: recommendedMaxRunning, maxRunningPerUser: recommendedMaxRunningPerUser },
    current: getLiveRuntimeBoxCapacity(),
  };
}

/** Persist and immediately activate admin-selected limits; recommendations are warnings, not hard caps. */
export async function updateRuntimeBoxCapacity(input: RuntimeBoxCapacitySettings, updatedBy?: number | null) {
  const next = {
    maxRunning: positiveInteger(input.maxRunning, 'maxRunning'),
    maxRunningPerUser: positiveInteger(input.maxRunningPerUser, 'maxRunningPerUser'),
  };
  await execute(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [SETTINGS_KEY, JSON.stringify(next), updatedBy ?? null],
  );
  liveSettings = next;
  return getRuntimeBoxCapacity();
}
