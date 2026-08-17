import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/fleet/check-ai-capabilities.sh'), 'utf8');

const expectedEnvNames = [
  'AGENT_STORE_API_KEY',
  'APIFY_TOKEN',
  'FIRECRAWL_API_KEY',
  'OPENAI_IMAGE_API_KEY',
];

describe('fleet managed credential readiness', () => {
  it('checks the standard env names rather than credential ids', () => {
    for (const envName of expectedEnvNames) expect(source).toContain(envName);
    expect(source).toContain('COALESCE(default_env_name, secret_name)');
    expect(source).not.toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(source).not.toContain('CLOUDFLARE_API_TOKEN');
  });

  it('uses the product resolver for a representative-project presence smoke', () => {
    expect(source).toContain('resolveRuntimeBoxApiKeyEnv');
    expect(source).toContain('SELECT id FROM projects ORDER BY created_at LIMIT 1');
    expect(source).toContain('present-redacted');
    expect(source).toContain('representative project materialization: 4/4 present-redacted');
  });

  it('supports both current bootstrap app paths', () => {
    expect(source).toContain('if [[ -d ~/apps/tower ]]; then cd ~/apps/tower; elif [[ -d ~/tower ]]');
  });
});
