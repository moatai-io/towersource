import { describe, expect, it } from 'vitest';
import { clampResponsesOutputBudget } from '../pi/responses-output-budget.js';
describe('Responses output reservation independent of compaction', () => {
  it('bounds the reported high-context request without changing history', () => {
    const input = [{ type: 'message', content: 'preserved' }];
    const body = { input, max_output_tokens: 95862 };
    expect(clampResponsesOutputBudget(body, 353400, 339020)).toBe(true);
    expect(body.max_output_tokens).toBe(3778);
    expect(body.input).toBe(input);
  });
  it('keeps an already safe budget', () => {
    const body = { max_output_tokens: 128000 };
    expect(clampResponsesOutputBudget(body, 353400, 100000)).toBe(false);
    expect(body.max_output_tokens).toBe(128000);
  });
  it('does not reject oversized estimated input or remove all output', () => {
    const body = { max_output_tokens: 128000 };
    expect(clampResponsesOutputBudget(body, 353400, 900000)).toBe(true);
    expect(body.max_output_tokens).toBe(1024);
  });
  it.each([undefined, NaN, 0, -1])('passes through unknown/invalid context %s', context => {
    const body = { max_output_tokens: 128000 };
    expect(clampResponsesOutputBudget(body, context, 339020)).toBe(false);
  });
});
