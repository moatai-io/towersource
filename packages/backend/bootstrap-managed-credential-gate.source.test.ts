import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/azure/bootstrap-prod.sh'), 'utf8');

const expectedEnvNames = [
  'AGENT_STORE_API_KEY',
  'APIFY_TOKEN',
  'FIRECRAWL_API_KEY',
  'OPENAI_IMAGE_API_KEY',
];

describe('self-hosted deployment bootstrap credential readiness gate', () => {
  it('seeds and verifies the standard managed credential env set', () => {
    for (const envName of expectedEnvNames) {
      expect(source).toContain(`seed_workspace_api_key_credential ${envName}`);
      expect(source).toContain(envName);
    }
    expect(source).toContain('verify_managed_workspace_credentials');
    expect(source).toContain("scope = 'workspace'");
    expect(source).toContain('resolveRuntimeBoxApiKeyEnv');
    expect(source).toContain('4/4 present-redacted');
    expect(source).not.toContain('seed_workspace_api_key_credential CLOUDFLARE_API_TOKEN');
  });

  it('fails the managed bootstrap before reporting completion when the gate fails', () => {
    const gateCall = source.indexOf('if ! verify_managed_workspace_credentials; then');
    const completion = source.indexOf('Bootstrap complete (tier: $TIER)');
    expect(gateCall).toBeGreaterThan(-1);
    expect(completion).toBeGreaterThan(gateCall);
    expect(source.slice(gateCall, completion)).toContain('exit 1');
  });
});
