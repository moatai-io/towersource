import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');

describe('Primary Agent self-hosted VM route contract', () => {
  it('mounts the creation API wherever Agent-first hiring is enabled', () => {
    expect(source).toContain("if (config.agentFirstEnabled) router.use('/primary-agent-commands', primaryAgentRouter);");
    expect(source).not.toMatch(/if \(config\.towerRole === 'full'\) \{[\s\S]{0,240}primary-agent-commands/);
  });

  it('enables AI Service management by product gate while keeping Harness administration full-only', () => {
    expect(source).toContain("if (config.aiServicesEnabled) router.use('/ai-services', aiServiceRouter);");
    expect(source).toContain("if (config.towerRole === 'full') router.use('/harnesses', harnessRouter);");
  });
});
