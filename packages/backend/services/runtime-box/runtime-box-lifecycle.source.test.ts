import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');

describe('Runtime Box lifecycle error recovery contract', () => {
  it('clears stale failure metadata after a successful start', () => {
    expect(source).toMatch(/SET status = 'running',[\s\S]*last_error = NULL, error_at = NULL/);
  });

  it('reclaims and retries once when docker reports the deterministic box-name conflict', () => {
    expect(source).toContain('isDockerContainerNameConflict(result.stderr, containerName)');
    expect(source).toContain("await spawnDockerCmd(['rm', '-f', containerName]);\n    result = await spawnDockerCmd(runArgs);");
  });
});
