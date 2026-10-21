import { describe, expect, it } from 'vitest';
import { validRouterUsageQuery } from './usage-request.js';
describe('router usage query boundary', () => {
  it('accepts only supported scopes, periods and bounded days', () => {
    expect(validRouterUsageQuery({})).toBe(true);
    expect(validRouterUsageQuery({ scope: 'team', period: 'calendar_month', days: '30' })).toBe(true);
    expect(validRouterUsageQuery({ scope: 'key', period: 'lifetime', days: '180' })).toBe(true);
  });
  it.each([
    { team_id: 'other-team' }, { api_key: 'other-key' }, { scope: 'all' }, { period: 'year' },
    { days: '0' }, { days: '181' }, { days: 'NaN' }, { days: '1.5' }, { days: ['7'] }, { scope: ['team'] },
  ])('rejects caller identity overrides and invalid shapes: %j', (query) => {
    expect(validRouterUsageQuery(query)).toBe(false);
  });
});
