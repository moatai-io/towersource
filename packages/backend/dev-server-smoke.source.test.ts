import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), '__tests__/dev-server-smoke.test.ts'), 'utf8');

describe('dev server smoke source contract', () => {
  it('does not make exact-SHA preflight depend on unrelated local dev servers', () => {
    expect(source).toContain("process.env.TOWER_DEV_SERVER_SMOKE === '1' ? describe : describe.skip");
    expect(source).toContain("fetchSafe('http://localhost:32354/api/sessions')");
    expect(source).toContain("fetchSafe('http://localhost:32355/api/sessions')");
  });
});
