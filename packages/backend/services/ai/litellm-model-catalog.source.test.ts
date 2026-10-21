import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.resolve(import.meta.dirname, relative), 'utf8');

describe('LiteLLM catalog route and UI wiring', () => {
  it('exposes operator catalog read, refresh, and allow-list mutation routes', () => {
    const api = read('../../routes/api.ts');
    expect(api).toContain("'/admin/ai-models/litellm-catalog'");
    expect(api).toContain("'/admin/ai-models/litellm-catalog/refresh'");
    expect(api).toContain("'/admin/ai-models/litellm-catalog/:modelId'");
    expect(api).toContain('operatorOrAboveMiddleware');
  });

  it('rebuilds the Pi registry before announcing a saved admin model list', () => {
    const api = read('../../routes/api.ts');
    const route = api.slice(api.indexOf("router.put('/admin/models'"), api.indexOf("router.patch('/sessions/:id'"));
    expect(route).toMatch(/saveModelsFile\(data\);[\s\S]*?await piEngine\.reloadModelRegistry\?\.\(\);[\s\S]*?broadcast\(/);
  });

  it('uses selectable models rather than free text for persistent agents', () => {
    const panel = read('../../../frontend/src/components/agents/AgentsPanel.tsx');
    expect(panel).toContain('selectablePiModels.map');
    expect(panel).not.toContain('placeholder="litellm-responses/smartest"');
  });

  it('does not label direct LiteLLM model IDs as policies', () => {
    for (const relative of [
      '../agent-communication/session-turn-runner.ts',
      '../task/task-runner.ts',
      './proactive-agent.ts',
    ]) expect(read(relative)).toContain('isModelPolicyId');
  });
});
