import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './pi-runtime-box-tools.ts'), 'utf8');

describe('Project service execution routing', () => {
  it('routes the compatibility service_start tool through the unified execution broker path', () => {
    const start = source.indexOf("name: 'service_start'");
    const end = source.indexOf("name: 'service_stop'", start);
    const block = source.slice(start, end);
    expect(block).toContain('return (workbenchExecuteTool.execute as any)(_toolCallId');
    expect(block).toContain("lifecycle: 'service'");
    expect(block).not.toContain('getOrCreateBox(');
    expect(block).not.toContain('registerService(');
    expect(block).not.toContain('startServiceProcess(');
  });

  it('keeps Project Environment admission and provider selection in the delegated path', () => {
    const executeStart = source.indexOf("name: 'bash'");
    const serviceStart = source.indexOf("name: 'service_start'");
    const block = source.slice(executeStart, serviceStart);
    expect(block).toContain('resolveProjectExecutionContext({');
    expect(block).toContain('selectProjectExecutionProvider({');
    expect(block).toContain('executeWorkbenchRequest({');
  });
});
