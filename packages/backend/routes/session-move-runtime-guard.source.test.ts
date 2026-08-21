import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const apiSource = fs.readFileSync(path.resolve(import.meta.dirname, 'api.ts'), 'utf8');

describe('session move runtime guard route', () => {
  it('maps pinned runtime rebind failures to an explicit 409 response', () => {
    expect(apiSource).toContain("err instanceof SessionRuntimeRebindRequiredError");
    expect(apiSource).toContain("err?.code === 'SESSION_RUNTIME_REBIND_REQUIRED'");
    expect(apiSource).toContain("res.status(409).json");
    expect(apiSource).toContain("error: 'session_runtime_rebind_required'");
  });
});
