import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/fleet/fleet-deploy-async.sh'), 'utf8');

describe('self-host deploy runtime package contract', () => {
  it('repoints @tower/shared to the built runtime package before restarting tower-prod', () => {
    const buildIndex = script.indexOf('step "build"');
    const linkIndex = script.indexOf('step "link runtime packages"');
    const restartIndex = script.indexOf('step "restart tower-prod"');

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeGreaterThan(buildIndex);
    expect(restartIndex).toBeGreaterThan(linkIndex);
    expect(script).toContain('rm -rf node_modules/@tower/shared');
    expect(script).toContain('ln -s ../../dist/runtime-packages/@tower/shared node_modules/@tower/shared');
    expect(script).toContain('node_modules/@tower/shared/index.js missing');
  });
});
