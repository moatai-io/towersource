import { describe, it, expect, beforeAll } from 'vitest';
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

  it('sharePublicUrl은 운영 desk alias만 canonical tower host로 정규화한다', () => {
    expect(config.resolveSharePublicUrl('https://desk.tower.example.com')).toBe('https://tower.tower.example.com');
    expect(config.resolveSharePublicUrl('https://desk-dev.tower.example.com')).toBe('https://desk-dev.tower.example.com');
    expect(config.resolveSharePublicUrl('https://demo-org.tower.example.com')).toBe('https://demo-org.tower.example.com');
  });

  it('모델 기본값은 활성화된 엔진 집합 안에서만 반환한다', () => {
    const defaults = config.getModelDefaults();
    if (config.config.piEnabled) {
      expect(defaults.session).toBe('litellm-responses/smartest');
      expect(defaults.ai_reply).toBe('litellm-responses/mini');
      expect(defaults.ai_task).toBe('litellm-responses/mini');
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

  it('retired Pi session models normalize to the configured Smartest default', () => {
    expect(config.normalizePiSessionModelId('openai-codex/gpt-5.5')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('codex-lb/gpt-5.5')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('litellm/smartest')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('litellm/smart')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('smart')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('balanced')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('claude-opus-4-8')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('azure-openai-responses/gpt-5.4')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('openrouter/moonshotai/kimi-k2.6')).toBe('openrouter/moonshotai/kimi-k2.6');
    expect(config.normalizePiSessionModelId('openrouter/moonshotai/kimi-k3')).toBe('openrouter/moonshotai/kimi-k3');
    expect(config.normalizePiSessionModelId('openrouter/anthropic/claude-sonnet-4.6')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId(null)).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('pi:litellm-responses/smartest-long')).toBe('litellm-responses/smartest-long');
    expect(config.normalizePiSessionModelId('litellm-responses/smartest')).toBe('litellm-responses/smartest');
    expect(config.normalizePiSessionModelId('litellm-responses/smart')).toBe('litellm-responses/smart');
    expect(config.normalizePiSessionModelId('litellm-responses/gpt55')).toBe('litellm-responses/gpt55');
    expect(config.normalizePiSessionModelId('azure-openai-responses-eastus2/gpt-5.5')).toBe('azure-openai-responses-eastus2/gpt-5.5');
  });
});
