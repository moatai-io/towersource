import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const supervisor = fs.readFileSync(path.resolve(import.meta.dirname, './turn-supervisor.ts'), 'utf8');
const engine = fs.readFileSync(path.resolve(import.meta.dirname, '../../engines/pi-engine.ts'), 'utf8');

describe('recovery boot takeover', () => {
  it('allows only explicit startup recovery to fence a previous boot owner', () => {
    expect(supervisor).toContain('takeoverPreviousBoot?: boolean');
    expect(supervisor).toContain('owner_boot_id IS DISTINCT FROM $6');
    expect(supervisor).toContain('NOT ($5::boolean');
    expect(engine).toContain("takeoverPreviousBoot: opts.autoResumeReason === 'server-restart'");
    expect(engine).toContain('takeoverPreviousBoot: false');
  });

  it('binds lease renewal to both fencing token and boot identity', () => {
    expect(supervisor).toContain('owner_token = $2 AND owner_boot_id = $4');
    expect(engine).toContain('ownerBootId: config.serverEpoch');
  });
});
