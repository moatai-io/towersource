import { describe, expect, it } from 'vitest';
import { measureInitialResponsesContext } from './initial-context-metrics.js';

describe('initial Responses context metrics', () => {
  it('keeps image byte sizes independent from approximate vision tokens', () => {
    const small = measureInitialResponsesContext({ input: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }, 'image-small');
    const large = measureInitialResponsesContext({ input: [{ type: 'input_image', image_url: 'data:image/png;base64,'+'A'.repeat(1000000) }] }, 'image-large');
    expect((large!.request as any).bytes).toBeGreaterThan((small!.request as any).bytes);
    expect((large!.request as any).estimatedTokens).toBe((small!.request as any).estimatedTokens);
  });

  it('reports only aggregate sizes once per session without leaking prompt, names or values', () => {
    const body = {
      instructions: 'PRIVATE_INSTRUCTION_123',
      input: [{ role: 'user', content: 'PRIVATE_USER_123' }],
      tools: [{ name: 'PRIVATE_TOOL_123', description: 'PRIVATE_DESCRIPTION_123', parameters: { type: 'object' } }],
    };
    const report = measureInitialResponsesContext(body, 'initial-context-test-1');
    expect(report).toMatchObject({ kind: 'initial-responses-context', tools: { count: 1 } });
    expect((report?.instructions as any).bytes).toBeGreaterThan(0);
    expect((report?.request as any).bytes).toBeGreaterThan((report?.instructions as any).bytes);
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|PRIVATE_TOOL_123/);
    expect(measureInitialResponsesContext(body, 'initial-context-test-1')).toBeNull();
    expect(measureInitialResponsesContext(body, undefined)).toBeNull();
  });
});
