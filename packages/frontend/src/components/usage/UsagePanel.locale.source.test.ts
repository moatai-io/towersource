import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'UsagePanel.tsx'), 'utf8');

describe('UsagePanel locale contract', () => {
  it('routes controls, summaries, empty states, and charts through locale keys', () => {
    for (const key of [
      'usage.description',
      'usage.days',
      'usage.totalUserTurns',
      'usage.loadFailed',
      'usage.empty',
      'usage.budgetDescription',
      'usage.dailyApiTokens',
      'usage.allProjectsDailyTurns',
    ]) expect(source).toContain(key);
  });
});
