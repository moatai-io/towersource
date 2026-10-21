import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Phase 0B — PROJECT_ROOT path resolution regression guard.
 * These tests lock down the current path assumptions so we catch
 * breakage when config.ts moves to packages/backend/.
 */

// Import the live config to test actual resolved values
const config = await import('./config.js');

// Derive PROJECT_ROOT the same way config.ts does (now in packages/backend/)
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = __dirname.includes('dist')
  ? path.resolve(__dirname, '..', '..')
  : path.resolve(__dirname, '..', '..');

describe('config — PROJECT_ROOT path resolution', () => {
  beforeAll(() => {
    // Ensure data directory exists for tests (git-ignored, created as needed)
    const dataDir = path.join(PROJECT_ROOT, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  });

  it('VM model registry path uses a writable data override when present', () => {
    const resolved = config.getModelsConfigPath();
    expect(resolved.endsWith('/data/models.json') || resolved.endsWith('/packages/backend/models.json')).toBe(true);
  });

  it('PROJECT_ROOT에 package.json이 존재한다', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))).toBe(true);
  });

  it('config.dataDir가 data로 끝난다', () => {
    expect(config.config.dataDir).toMatch(/data$/);
  });

  it('config.frontendDir가 dist/frontend로 끝난다', () => {
    expect(config.config.frontendDir).toMatch(/dist[/\\]frontend$/);
  });

  it('PROJECT_ROOT/data 디렉토리가 존재한다', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'data'))).toBe(true);
  });

  it('기본 엔진은 명시 override가 없으면 Pi다', () => {
    expect(config.config.defaultEngine).toBe(process.env.DEFAULT_ENGINE || 'pi');
  });

  it('git auto-commit은 명시적으로 GIT_AUTO_COMMIT=true일 때만 켜진다', () => {
    expect(config.config.gitAutoCommit).toBe(process.env.GIT_AUTO_COMMIT === 'true');
  });

  it('sharePublicUrl은 배포별 alias를 추측하지 않고 입력 host를 보존한다', () => {
    expect(config.resolveSharePublicUrl('https://app.example.com')).toBe('https://app.example.com');
    expect(config.resolveSharePublicUrl('https://dev.example.com')).toBe('https://dev.example.com');
    expect(config.resolveSharePublicUrl('')).toBe('');
  });

  it('모델 기본값은 활성화된 엔진 집합 안에서만 반환한다', () => {
    const defaults = config.getModelDefaults();
    if (config.config.piEnabled) {
      const fileDefaults = config.loadModelsFile().defaults!;
      expect(defaults).toEqual(fileDefaults);
    } else {
      expect(defaults.session).toBeTruthy();
      expect(defaults.ai_reply).toBeTruthy();
      expect(defaults.ai_task).toBeTruthy();
    }
  });

  it('retired Claude session models should lazily migrate to Pi Smartest when Pi is enabled', () => {
    expect(config.shouldAutoMigrateClaudeSessionToPi({
      engine: 'claude',
      model: 'claude-opus-4-8',
      claudeEnabled: true,
      piEnabled: true,
    })).toBe(true);
    expect(config.shouldAutoMigrateClaudeSessionToPi({
      engine: 'claude',
      model: 'claude-sonnet-4-6',
      claudeEnabled: true,
      piEnabled: true,
    })).toBe(false);
    expect(config.shouldAutoMigrateClaudeSessionToPi({
      engine: 'claude',
      model: 'claude-sonnet-4-6',
      claudeEnabled: false,
      piEnabled: true,
    })).toBe(true);
    expect(config.shouldAutoMigrateClaudeSessionToPi({
      engine: 'claude',
      model: 'claude-opus-4-8',
      claudeEnabled: true,
      piEnabled: false,
    })).toBe(false);
    expect(config.shouldAutoMigrateClaudeSessionToPi({
      engine: 'pi',
      model: 'claude-opus-4-8',
      claudeEnabled: true,
      piEnabled: true,
    })).toBe(false);
  });

  it('keeps Core/Lite slots visible even when their VM mappings are missing', () => {
    const configPath = config.getModelsConfigPath();
    const originalRead = fs.readFileSync;
    const source = JSON.parse(originalRead(configPath, 'utf8') as string);
    const isolated = { ...source, defaults: { ...source.defaults, session: 'litellm-responses/unavailable-core', ai_task: 'litellm-responses/unavailable-lite' } };
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) =>
      String(file) === configPath ? JSON.stringify(isolated) : (originalRead as any)(file, ...args)) as typeof fs.readFileSync);
    try {
      const slots = config.reloadModels().pi.slice(0, 2);
      expect(slots.map(model => model.id)).toEqual(['pi:preset/core', 'pi:preset/lite']);
      expect(config.isSelectablePiModelId('pi:preset/core')).toBe(true);
      expect(config.isSelectablePiModelId('pi:preset/lite')).toBe(true);
    } finally {
      spy.mockRestore();
      config.reloadModels();
    }
  });

  it('only accepts explicitly selectable Pi models for user requests', () => {
    const visible = config.reloadModels().pi;
    expect(visible.slice(0, 2).map(model => model.id)).toEqual(['pi:preset/core', 'pi:preset/lite']);
    expect(config.isSelectablePiModelId('pi:preset/core')).toBe(true);
    expect(config.isSelectablePiModelId('pi:policy/core')).toBe(true);
    // The slot remains visible even when its mapped entry is absent: execution
    // readiness is checked separately, rather than dropping Core from the menu.
    const registry = JSON.parse(fs.readFileSync(config.getModelsConfigPath(), 'utf8'));
    const sol = registry.pi.find((entry: { modelId: string }) => entry.modelId === 'gpt-5.6-sol');
    expect(config.isSelectablePiModelId('pi:litellm-responses/gpt-5.6-sol')).toBe(
      !!sol && config.isPiModelEntrySelectableForThisVm(sol, registry.litellmCatalog?.syncedAt),
    );
    expect(config.isPiModelEntrySelectableForThisVm({ provider: 'litellm-responses', modelId: 'gpt-5.6-sol', name: 'Sol', enabled: true })).toBe(false);
    // A hidden VM-local alias remains executable even when not in the picker.
    expect(config.isSelectablePiModelId('pi:litellm-responses/smartest')).toBe(false);
    expect(config.isPiModelEntrySelectableForThisVm({ provider: 'litellm-responses', modelId: 'smartest', name: 'Smartest', enabled: true, hidden: true, selectable: false })).toBe(false);
    expect(config.isPiModelEntrySelectableForThisVm({ provider: 'litellm-responses', modelId: 'mini', name: 'Mini', enabled: true, hidden: true, selectable: false })).toBe(true);
    expect(config.resolveLegacyPiModelId('litellm-responses/smartest')).toBe('litellm-responses/smartest');
    expect(config.isSelectablePiModelId('litellm-responses/unknown-direct')).toBe(false);
    expect(config.isSelectablePiModelId('openrouter/unknown-provider-model')).toBe(false);
    for (const id of ['astra-canary', 'smartest-long', 'sol-fast', 'gpt55', 'smart']) {
      expect(config.isPiModelEntrySelectableForThisVm({ provider: 'litellm-responses', modelId: id, name: id, enabled: true })).toBe(false);
    }
    expect(config.isPiModelEntrySelectableForThisVm({ provider: 'azure-openai-responses-eastus2', modelId: 'gpt-5.5', name: 'Azure', enabled: true })).toBe(false);
  });

  it('retired Pi session models normalize to the active VM default', () => {
    expect(config.normalizePiSessionModelId('openai-codex/gpt-5.5')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('codex-lb/gpt-5.5')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('litellm/smartest')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('litellm/smart')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('smart')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('balanced')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('claude-opus-4-8')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('azure-openai-responses/gpt-5.4')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('litellm-responses/mini')).toBe('litellm-responses/mini');
    expect(config.normalizePiSessionModelId('azure-openai-responses-eastus2/gpt-5.5')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('openrouter/moonshotai/kimi-k2.6')).toBe('openrouter/moonshotai/kimi-k2.6');
    expect(config.normalizePiSessionModelId('openrouter/moonshotai/kimi-k3')).toBe('openrouter/moonshotai/kimi-k3');
    expect(config.normalizePiSessionModelId('openrouter/anthropic/claude-sonnet-4.6')).toBe('preset/core');
    expect(config.normalizePiSessionModelId(null)).toBe('preset/core');
    expect(config.normalizePiSessionModelId('pi:litellm-responses/smartest-long')).toBe('litellm-responses/smartest-long');
    expect(config.normalizePiSessionModelId('litellm-responses/smartest')).toBe('preset/core');
    expect(config.normalizePiSessionModelId('litellm-responses/smart')).toBe('litellm-responses/smart');
    expect(config.normalizePiSessionModelId('litellm-responses/gpt55')).toBe('preset/core');
  });
});

describe('Pi hidden-model compatibility', () => {
  it('keeps hidden entries executable but not selectable', () => {
    const previousRole = process.env.TOWER_ROLE;
    process.env.TOWER_ROLE = 'full';
    try {
      const model = { provider: 'litellm-responses', modelId: 'smartest-long', name: 'Legacy', enabled: true, hidden: true };
      expect(config.isPiModelEntryEnabledForThisVm(model)).toBe(true);
      expect(config.isPiModelEntrySelectableForThisVm(model)).toBe(false);
      expect(config.isPiModelEntrySelectableForThisVm({ ...model, hidden: false }, '2026-09-22')).toBe(false);
      expect(config.isPiModelEntryEnabledForThisVm({ ...model, enabled: false })).toBe(false);
      expect(config.isPiModelEntryEnabledForThisVm({ ...model, roles: [] })).toBe(true);
    } finally {
      if (previousRole === undefined) delete process.env.TOWER_ROLE;
      else process.env.TOWER_ROLE = previousRole;
    }
  });

  it('exposes explicitly allowed VM registry models on managed and standalone VMs', () => {
    const previousRole = process.env.TOWER_ROLE;
    try {
      for (const role of ['managed', 'standalone']) {
        process.env.TOWER_ROLE = role;
        const models = config.reloadModels();
        expect(models.claude).toEqual([]);
        expect(models.local).toEqual([]);
        const registry = JSON.parse(fs.readFileSync(config.getModelsConfigPath(), 'utf8'));
        for (const physical of ['gpt-5.6-sol', 'gpt-5.6-terra']) {
          const entry = registry.pi.find((candidate: { modelId: string }) => candidate.modelId === physical);
          expect(models.pi.some((model) => model.id === `pi:litellm-responses/${physical}`)).toBe(
            !!entry && config.isPiModelEntrySelectableForThisVm(entry, registry.litellmCatalog?.syncedAt),
          );
        }
        expect(config.isPiModelEntrySelectableForThisVm({ provider: 'litellm-responses', modelId: 'smart', name: 'Smart', enabled: true })).toBe(false);
      }
    } finally {
      if (previousRole === undefined) delete process.env.TOWER_ROLE;
      else process.env.TOWER_ROLE = previousRole;
      config.reloadModels();
    }
  });

  it('keeps the full Tower model selector controlled by the registry', () => {
    const previousRole = process.env.TOWER_ROLE;
    const originalRead = fs.readFileSync.bind(fs);
    const fixture = { claude: [], local: [{ id: 'fixture-local', name: 'Fixture Local', enabled: true }], pi: [
      { provider: 'litellm-responses', modelId: 'fixture-listed', name: 'Listed', enabled: true, lastSeenAt: '2026-01-01' },
      { provider: 'litellm-responses', modelId: 'fixture-disabled', name: 'Disabled', enabled: false },
      { provider: 'litellm-responses', modelId: 'gpt55', name: 'Retired', enabled: true },
    ], litellmCatalog: { syncedAt: '2026-01-01' } };
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => String(file) === config.getModelsConfigPath() ? JSON.stringify(fixture) : (originalRead as any)(file, ...args)) as any);
    process.env.TOWER_ROLE = 'full';
    try {
      const models = config.reloadModels();
      expect(models.pi.map((model) => model.id)).not.toContain('pi:litellm-responses/gpt55');
      expect(models.pi.map(model => model.id)).toContain('pi:litellm-responses/fixture-listed');
      expect(models.pi.map(model => model.id)).not.toContain('pi:litellm-responses/fixture-disabled');
      expect(models.local.map(model => model.id)).toContain('local:fixture-local');
    } finally {
      readSpy.mockRestore();
      if (previousRole === undefined) delete process.env.TOWER_ROLE;
      else process.env.TOWER_ROLE = previousRole;
      config.reloadModels();
    }
  });

  it('preserves distinct Astra and long-context model selections', () => {
    expect(config.normalizePiSessionModelId('litellm-responses/astra-canary')).toBe('litellm-responses/astra-canary');
    expect(config.normalizePiSessionModelId('pi:litellm-responses/astra-canary')).toBe('litellm-responses/astra-canary');
    expect(config.normalizePiSessionModelId('litellm-responses/smartest-long')).toBe('litellm-responses/smartest-long');
    expect(config.normalizePiSessionModelId('custom-provider/custom-model')).toBe('preset/core');
  });
});
