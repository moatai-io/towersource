import { describe, expect, it } from 'vitest';
import { gatewayPriceReferences } from './pricing-reference.js';

describe('gateway price references', () => {
  it('keeps sources, dates and use-case billing units on every entry', () => {
    for (const row of gatewayPriceReferences) {
      expect(row.sourceUrl).toMatch(/^https:\/\//);
      expect(row.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.unit.length).toBeGreaterThan(0);
      expect(row.caveat.length).toBeGreaterThan(0);
      if (row.rate !== undefined) expect(row.rate).toBeGreaterThanOrEqual(0);
    }
  });
  it('never encodes unknown or plan-dependent rates as free', () => {
    for (const row of gatewayPriceReferences.filter(row => row.status !== 'published')) {
      expect(row.rate).toBeUndefined();
    }
  });
  it('covers all seeded provider routes plus platform overhead and candidate parser', () => {
    expect(new Set(gatewayPriceReferences.map(row => row.apiId))).toEqual(new Set([
      'firecrawl', 'apify', 'naver', 'openai', 'agent-store', 'openrouter-jev', 'openai-image', 'corepin', 'zuplo-platform', 'speech-to-text',
    ]));
  });
  it('converts Jev per-million pricing without confusing zero output with unknown', () => {
    const rows = gatewayPriceReferences.filter(row => row.apiId === 'openrouter-jev');
    expect(rows.find(row => row.unit === 'input-token')!.rate! * 1e6).toBeCloseTo(0.042);
    expect(rows.find(row => row.unit === 'output-token')!.rate).toBe(0);
  });
});
