import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const frontendSource = fs.readFileSync(path.join(__dirname, 'AdminPanel.tsx'), 'utf8');
const backendSource = fs.readFileSync(path.join(__dirname, '../../../../backend/routes/api.ts'), 'utf8');
const configSource = fs.readFileSync(path.join(__dirname, '../../../../backend/config.ts'), 'utf8');
const models = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../backend/models.json'), 'utf8'));

describe('retired direct Codex connection contract', () => {
  it('does not expose a separate direct Codex account connection in Admin', () => {
    expect(frontendSource).not.toContain('CodexAuthStatus');
    expect(frontendSource).not.toContain('codexAuth');
    expect(frontendSource).not.toContain('/admin/openai-codex-auth/status');
    expect(frontendSource).not.toContain('login openai-codex');
  });

  it('does not expose the retired status-only backend endpoint', () => {
    expect(backendSource).not.toContain("router.get('/admin/openai-codex-auth/status'");
    expect(backendSource).not.toContain('getCodexAuthStatus');
  });

  it('keeps current routing and old-session compatibility separate from the removed UI', () => {
    expect(models.defaults.session).toBe('litellm-responses/gpt-6.1-sol');
    expect(models.pi.some((model: { provider: string }) => model.provider === 'openai-codex')).toBe(false);
    expect(configSource).toContain("'openai-codex/gpt-5.5'");
    expect(configSource).toContain('RETIRED_PI_SESSION_MODEL_IDS');
  });
});
