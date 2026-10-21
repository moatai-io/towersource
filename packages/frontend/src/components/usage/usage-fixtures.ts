// Synthetic numeric contract fixture. Never use production customer/key identifiers.
export function routerFixture(days = 30) {
  return {
    freshness: 'live', observedAt: '2026-09-23T12:00:00Z',
    usage: {
      source: 'litellm-spendlogs', scope: 'team', period: 'calendar_month', days,
      key: { spend: 999, max_budget: 1000 },
      team: { team_id: 'team-test', team_alias: 'Example team', spend: 888, max_budget: 500 },
      summary: { requests: 19, cost_usd: 12.34, input_tokens: 8000, output_tokens: 2000, total_tokens: 10000 },
      budget_window: { requests: 7, cost_usd: 4, input_tokens: 3000, output_tokens: 500, total_tokens: 3500,
        starts_at: '2026-09-20T00:00:00Z', resets_at: '2026-10-20T00:00:00Z', max_budget: 50 },
      daily: [
        { date: '2026-08-24', requests: 3, cost_usd: 1.25, input_tokens: 100, output_tokens: 20 },
        { date: '2026-09-23', requests: 5, cost_usd: 2.5, input_tokens: 200, output_tokens: 40 },
      ], models: [], projects: [],
    },
  };
}
export const activityFixture = {
  days: 30, topN: 20, dates: ['2026-09-22', '2026-09-23'], dailyTotals: [100, 20], grandTotal: 120,
  projects: [{ id: 'p1', name: 'Example project', values: [1, 10], total: 11, sessions: 1, activeDays: 2 }],
};
export const fallbackFixture = {
  rows: [{ ok: true, spend: 2, maxBudget: 10 }], capturedAt: '2026-09-23T12:00:00Z',
  usage: { source: 'tower-db-metadata', accuracy: 'key-window-local', days: 30,
    totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.5, turns: 2 },
    daily: [{ date: '2026-09-23', inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.5, turns: 2 }],
  },
};
