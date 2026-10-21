import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
describe('goal ownership stays outside engine lifecycle', () => {
  for (const file of ['packages/backend/engines/pi-engine.ts', 'packages/backend/engines/pi/tool-assembly.ts', 'packages/backend/engines/types.ts', 'packages/backend/routes/ws-handler.ts']) {
    it(`${file} does not own goal admission or continuation`, () => {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of ['goalRuntime', 'goalRequest', 'goalProvider', 'admitGoal', 'goalRequestFromInvocation']) expect(source).not.toContain(forbidden);
    });
  }
});
