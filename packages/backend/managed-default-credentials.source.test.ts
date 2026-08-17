import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const bootstrap = read('scripts/azure/bootstrap-prod.sh');
const deploy = read('scripts/azure/deploy-e2e.sh');
const capabilities = read('scripts/fleet/check-ai-capabilities.sh');
const fleetStatus = read('scripts/fleet/fleet-status.sh');

describe('self-hosted VM default credential contract', () => {
  it('requires Agent Store and does not seed Naver by default', () => {
    expect(bootstrap).toContain('seed_workspace_api_key_credential AGENT_STORE_API_KEY');
    expect(bootstrap).not.toContain('seed_workspace_api_key_credential NAVER_CLIENT_ID');
    expect(bootstrap).not.toContain('seed_workspace_api_key_credential NAVER_CLIENT_SECRET');
  });

  it('transports the required defaults during managed deployment', () => {
    expect(deploy).toContain('AGENT_STORE_API_KEY FIRECRAWL_API_KEY APIFY_TOKEN OPENAI_IMAGE_API_KEY');
    expect(deploy).not.toContain('FIRECRAWL_API_KEY APIFY_TOKEN NAVER_CLIENT_ID NAVER_CLIENT_SECRET');
  });

  it('treats Naver as optional in fleet readiness', () => {
    expect(capabilities).toContain('KEYS="AGENT_STORE_API_KEY FIRECRAWL_API_KEY APIFY_TOKEN OPENAI_IMAGE_API_KEY');
    expect(capabilities).not.toContain('for key in APIFY_TOKEN NAVER_CLIENT_ID NAVER_CLIENT_SECRET OPENAI_IMAGE_API_KEY');
    expect(fleetStatus).toContain('EXPECTED_VAULT_KEYS=(AGENT_STORE_API_KEY FIRECRAWL_API_KEY APIFY_TOKEN OPENAI_IMAGE_API_KEY');
  });

  it('parses the fleet registry without a host PyYAML dependency', () => {
    expect(fleetStatus).toContain("import YAML from 'yaml'");
    expect(fleetStatus).not.toContain('import sys, yaml');
    expect(fleetStatus).not.toContain('yaml.safe_load');
  });
});
