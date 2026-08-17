import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf-8');

describe('/api/agents latest run artifact contract', () => {
  it('returns artifact_paths with the latest agent run summary', () => {
    expect(SRC).toContain('SELECT id, status, result_summary, artifact_paths, error, started_at, ended_at, updated_at, metadata');
    expect(SRC).toContain('FROM agent_runs');
  });
});
