import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const patch = fs.readFileSync(path.join(root, 'scripts/fleet/fleet-patch'), 'utf8');

 describe('Fleet Gateway provisioning boundary', () => {
  it('exposes read-only status and exact-hash plan/apply entrypoints', () => {
    expect(patch).toContain('fleet-patch gateway-status CUSTOMER');
    expect(patch).toContain('fleet-patch gateway-plan CUSTOMER [--credential ID]');
    expect(patch).toContain('fleet-patch gateway-apply CUSTOMER [--credential ID] --approve-plan SHA256');
    expect(patch).toContain('[[ "$plan_hash" =~ ^[0-9a-f]{64}$ ]] || usage');
  });

  it('does not couple Gateway credential mutation to ordinary app rollout', () => {
    const apply = patch.slice(patch.indexOf('  apply)'), patch.indexOf('  status)'));
    expect(apply).not.toContain('customer-credential-sync');
    expect(apply).not.toContain('gateway-apply');
    expect(patch).toContain('Gateway mutation and requires the exact plan hash');
  });
});
