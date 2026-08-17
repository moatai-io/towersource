import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const manager = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/runtime-box/runtime-box-manager.ts'), 'utf8');
const types = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/runtime-box/types.ts'), 'utf8');

describe('Runtime Box explicit credential-free exec contract', () => {
  it('supports an internal none policy while preserving classifier auto mode for project_shell', () => {
    expect(types).toContain("credentialMode?: 'auto' | 'none'");
    expect(manager).toContain("req.credentialMode === 'none'");
    expect(manager).toContain('explicit internal credential-free execution policy');
    expect(manager).toContain(': shouldSuppressCredentialEnv(req.cmd)');
  });
});
