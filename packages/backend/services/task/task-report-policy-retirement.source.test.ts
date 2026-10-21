import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/api.ts'), 'utf8');
const manager = fs.readFileSync(path.resolve(import.meta.dirname, 'task-manager.ts'), 'utf8');
const severity = fs.readFileSync(path.resolve(import.meta.dirname, '../tower/severity-router.ts'), 'utf8');

describe('retired task channel report policy', () => {
  it('allows only current policies through the task REST creation surface', () => {
    expect(api).toContain("const VALID_POLICIES = ['silent', 'notification'] as const");
    expect(api).not.toContain("const VALID_POLICIES = ['silent', 'channel'");
  });

  it('normalizes every new or edited policy to a current value at the service boundary', () => {
    expect(manager).toContain("reportPolicy === 'notification' ? 'notification' : 'silent'");
    expect(manager).toContain("updates.reportPolicy === 'notification' ? 'notification' : 'silent'");
  });


  it('keeps legacy policies readable as Notification severity only', () => {
    expect(severity).toContain("case 'notification':");
    expect(severity).toContain("case 'channel':");
    expect(severity).toContain('notifyInApp: true');
    expect(severity).not.toContain('channelPost:');
  });
});
