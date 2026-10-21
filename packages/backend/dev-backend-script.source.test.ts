import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('backend dev script contract', () => {
  it('keeps the default dev backend stable while agents edit backend source', () => {
    const script = String(packageJson.scripts?.['dev:backend'] || '');
    expect(script).toContain('INLINE_EDIT_ENABLED=true');
    expect(script).toContain('tsx packages/backend/index.ts');
    expect(script).not.toContain('tsx watch');
    expect(script.trim().endsWith('packages/backend/index.ts')).toBe(true);
  });

  it('keeps hot restart available as an explicit opt-in script', () => {
    const script = String(packageJson.scripts?.['dev:backend:watch'] || '');
    expect(script).toContain('tsx watch');
    expect(script).toContain('INLINE_EDIT_ENABLED=true');
    expect(script).toContain("--exclude './packages/backend/db/migrations/*'");
    expect(script).not.toContain(' --ignore ');
    expect(script.trim().endsWith('packages/backend/index.ts')).toBe(true);
  });
});
