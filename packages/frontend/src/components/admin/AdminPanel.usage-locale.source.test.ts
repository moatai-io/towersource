import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../../locales/en/admin.json', import.meta.url), 'utf8'));
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/admin.json', import.meta.url), 'utf8'));

const keys = [
  'recentTokenUsage', 'inputOutputBasis', 'inputTokens', 'outputTokens', 'cacheRead',
  'estimatedCost', 'budgetRemaining', 'noTokenBudget', 'budgetLookupFailed', 'currentVm',
  'capturedAt', 'aiUsage', 'modelsUnknown', 'updatedAt', 'remainingAmount', 'noDuration',
];

describe('Admin AI usage locale contract', () => {
  it('routes the token usage dashboard through the admin locale', () => {
    expect(source).toContain("function TinyTokenUsageChart({ data }");
    expect(source).toContain("t('recentTokenUsage', { days: data.length })");
    expect(source).toContain("t('inputTokens')");
    expect(source).toContain("t('budgetLookupFailed')");
    expect(source).toContain("t('remainingAmount', { amount: formatBudgetMoney(remaining) })");
  });

  it('ships matching English and Korean usage labels', () => {
    for (const key of keys) {
      expect(en[key], `missing English admin usage key: ${key}`).toBeTruthy();
      expect(ko[key], `missing Korean admin usage key: ${key}`).toBeTruthy();
    }
  });
});
