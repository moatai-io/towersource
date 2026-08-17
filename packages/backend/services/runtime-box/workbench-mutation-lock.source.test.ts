import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(import.meta.dirname, 'workbench-tools.ts'), 'utf8');

describe('A4a Workbench mutation lock regression', () => {
  it('routes every Workbench revision writer through the shared M facade', () => {
    expect(source).not.toContain('pg_advisory_lock');
    expect(source).not.toContain('async function withMutationLock');
    expect(source.match(/withWorkbenchMutationLock\(input\.projectId/g)).toHaveLength(3);
  });
});
