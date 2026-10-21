import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/execution/worker/worker-server.ts'), 'utf8');

describe('Remote Worker project manifest root contract', () => {
  it('allows the Project root for directory manifests only', () => {
    expect(source).toContain("resolveProjectFile(input.projectRoot, input.relativePath, { allowRoot: true })");
    expect(source).toContain("function resolveProjectFile(projectRoot: string, requested: string, input: { allowRoot?: boolean } = {})");
    expect(source).toContain('(!input.allowRoot && resolved === root)');
    expect(source).toContain('const target = resolveProjectFile(input.projectRoot, input.relativePath);');
  });
});
