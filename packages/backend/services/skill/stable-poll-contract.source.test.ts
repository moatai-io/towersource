import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../../');
describe('stable updater opt-in polling contract', () => {
  it('keeps timer templates disabled and one-shot runner tied to deployed immutable entrypoint', () => {
    const service = fs.readFileSync(path.join(root, 'scripts/nix-app/templates/tower-teamskills-stable-poll.service.example'), 'utf8');
    const timer = fs.readFileSync(path.join(root, 'scripts/nix-app/templates/tower-teamskills-stable-poll.timer.example'), 'utf8');
    const runner = fs.readFileSync(path.join(root, 'packages/backend/scripts/teamskills-stable-poll.ts'), 'utf8');
    const updater = fs.readFileSync(path.join(root, 'packages/backend/scripts/teamskills-stable-update.ts'), 'utf8');
    expect(service).toContain('REPLACE_WITH_APPROVED_APP_CLOSURE');
    expect(service).toContain('REPLACE_WITH_NODE_CLOSURE');
    expect(timer).toContain('Example only');
    expect(timer).toContain('Persistent=false');
    expect(service).toContain('check-only');
    expect(service).toContain('TimeoutStartSec=150');
    expect(runner).toContain("entry.startsWith('/nix/store/')");
    expect(runner).toContain("[cli, '--check', '--registered-projects'");
    expect(runner).not.toContain("[cli, '--apply'");
    expect(runner).toContain("receipt.status !== 'eligible'");
    expect(runner).toContain('timeout: 120_000');
    expect(updater).toContain('selectStableUpdateProjectRoots(rows, getTeamskillsProjectRoot()');
    expect(updater).toContain('SELECT root_path FROM projects');
    expect(runner).not.toContain('setInterval(');
  });
});
