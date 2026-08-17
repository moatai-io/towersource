import { describe, expect, it } from 'vitest';
import { applyModelOutputBudget } from './model-output-budget-gateway.js';

const image = (bytes: number) => ({
  type: 'image',
  data: Buffer.alloc(bytes).toString('base64'),
  mimeType: 'image/png',
});

describe('ModelOutputBudgetGateway', () => {
  it('sanitizes and bounds text across all blocks', () => {
    const payload = Buffer.alloc(7000, 1).toString('base64');
    const result = applyModelOutputBudget([
      { type: 'text', text: `before data:image/png;base64,${payload} after` },
      { type: 'text', text: 'x'.repeat(100) },
    ], { maxTextChars: 200, maxImages: 2, maxImageBytes: 1000 });
    expect(result.content[0].text).toContain('embedded binary omitted');
    expect(result.textChars).toBeLessThanOrEqual(200);
    expect(result.truncated).toBe(true);
  });

  it('enforces aggregate image count and byte budgets', () => {
    const result = applyModelOutputBudget([image(40), image(40), image(40)], {
      maxTextChars: 1000,
      maxImages: 2,
      maxImageBytes: 70,
    });
    expect(result.content.filter(block => block.type === 'image')).toHaveLength(1);
    expect(result.omittedImages).toBe(2);
    expect(result.content.at(-1).text).toContain('2 image(s) omitted');
  });
});
