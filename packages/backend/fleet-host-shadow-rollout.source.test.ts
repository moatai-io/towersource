import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../scripts/fleet/fleet-host-shadow', import.meta.url), 'utf8');
const start = readFileSync(new URL('../../start.sh', import.meta.url), 'utf8');

describe('Fleet passive Host Shadow rollout', () => {
  it('resolves customers from the registry and requires exact approved revisions for mutations', () => {
    expect(source).toContain('FLEET_CUSTOMERS_FILE');
    expect(source).toContain('resolve_target');
    expect(source).toContain('--approve-rev');
    expect(source).toContain('[[ "$rev" =~ ^[0-9a-f]{40}$ ]]');
  });

  it('keeps the shadow loopback-only with isolated state and no provider credentials', () => {
    expect(source).toContain('PORT=32376; HOST=127.0.0.1');
    expect(source).toContain("WORKSPACE_ROOT='$RUN/workspace'");
    expect(source).toContain("TOWER_DATA_DIR='$RUN/data'");
    expect(source).toContain('TOWER_CANDIDATE_PASSIVE_MODE=true');
    expect(source).toContain('unset OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY GEMINI_API_KEY APIFY_API_TOKEN FIRECRAWL_API_KEY GH_TOKEN GITHUB_TOKEN');
  });

  it('uses a verified exact artifact and isolated database snapshot', () => {
    expect(source).toContain('artifactSha256');
    expect(source).toContain('sha256sum "$F"');
    expect(source).toContain('tower_shadow_passive_');
    expect(source).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(source).toContain('pg_restore --no-owner --no-privileges --no-comments');
  });

  it('verifies passive startup and preserves production authority', () => {
    expect(source).toContain("grep -q 'Candidate passive mode enabled'");
    expect(source).toContain("! grep -qE '\\[unified-scheduler");
    expect(source).toContain('curl -fsS http://127.0.0.1:32364/api/health');
    expect(source).toContain('productionMutation":false');
    expect(source).not.toContain('pm2 delete tower-prod');
  });

  it('routes through the shared start entrypoint', () => {
    expect(start).toContain('fleet-host-shadow)');
    expect(start).toContain('bash scripts/fleet/fleet-host-shadow "$@"');
  });
});
