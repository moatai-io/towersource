import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ws-handler.ts'), 'utf8');

describe('ws-handler engine session authority', () => {
  it('uses the DB pi_session_file over stale browser engineSessionId for Pi chat turns', () => {
    expect(source).toContain('const dbEngineSessionId = getEngineSessionId(dbSession) || undefined');
    expect(source).toContain("const clientEngineSessionId = engineName === 'claude'");
    expect(source).toContain("const engineSessionId = engineName === 'pi'");
    expect(source).toMatch(/engineName === 'pi'[\s\S]*\? dbEngineSessionId[\s\S]*: \(clientEngineSessionId \|\| dbEngineSessionId\)/);
  });
});
