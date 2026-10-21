/** Synthetic administrator registry for unit tests: no VM data, network, or keys. */
import fs from 'node:fs';
import { vi } from 'vitest';

export const packagedModels = JSON.parse(fs.readFileSync(new URL('../../models.json', import.meta.url), 'utf8'));
export function installModelRegistryFixture() {
  const registry = {
    ...structuredClone(packagedModels),
    defaults: { session: 'litellm-responses/fixture-core', ai_reply: 'litellm-responses/mini', ai_task: 'litellm-responses/mini' },
    pi: [
      { provider: 'litellm-responses', modelId: 'fixture-core', name: 'Fixture Core', enabled: true, api: 'openai-responses', lastSeenAt: '2026-01-01T00:00:00.000Z', reasoning: true, reasoningEfforts: ['low','medium','high','xhigh'] },
      { provider: 'litellm-responses', modelId: 'mini', name: 'Fixture Lite', enabled: true },
      { provider: 'openrouter', modelId: 'openrouter/auto', name: 'Fixture Direct', enabled: true },
    ],
    modelPolicies: { revision: 42, policies: {} },
    litellmCatalog: { syncedAt: '2026-01-01T00:00:00.000Z' },
  };
  const read = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
    if (String(file).endsWith('/models.json')) return JSON.stringify(registry);
    return (read as any)(file, ...args);
  }) as any);
  return registry;
}
