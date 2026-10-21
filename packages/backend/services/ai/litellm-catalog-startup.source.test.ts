import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const startup = fs.readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

describe('LiteLLM catalog startup refresh', () => {
  it('runs only on active Pi backends and does not block startup on lookup failure', () => {
    expect(startup).toContain('} else if (config.piEnabled) {');
    expect(startup).toContain('await refreshLiteLLMModelCatalog()');
    expect(startup).toContain('await piEngine.reloadModelRegistry?.()');
    expect(startup).toContain("broadcastToAll({ type: 'config_update'");
    expect(startup).toContain('previous snapshot retained');
  });
});
