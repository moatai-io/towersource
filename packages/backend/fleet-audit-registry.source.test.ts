import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'scripts/fleet', name), 'utf8');
const registryLib = read('fleet-customers-lib.sh');
const runtimeAudit = read('fleet-runtime-capability-audit.sh');
const depsAudit = read('fleet-deps-audit.sh');

describe('fleet audit customer registry contract', () => {
  it('uses the repository YAML dependency instead of host PyYAML', () => {
    expect(registryLib).toContain("import YAML from 'yaml'");
    expect(registryLib).toContain('fleet_customer_rows()');
    expect(registryLib).not.toContain('import sys, yaml');
    expect(runtimeAudit).not.toContain('import sys, yaml');
    expect(depsAudit).not.toContain('import sys, yaml');
  });

  it('fails closed when no customer row was actually audited', () => {
    expect(runtimeAudit).toContain('AUDITED=0');
    expect(runtimeAudit).toContain('No self-hosted servers were audited');
    expect(runtimeAudit).toContain('exit 3');
    expect(depsAudit).toContain('AUDITED=0');
    expect(depsAudit).toContain('No self-hosted servers were audited');
    expect(depsAudit).toContain('exit 3');
  });
});
