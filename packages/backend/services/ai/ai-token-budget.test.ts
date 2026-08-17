import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveCustomerNameFromPublicUrl, resolveCurrentBudgetCustomer } from './ai-token-budget';

describe('AI token budget visibility helpers', () => {
  it('derives customer slug from self-hosted VM PUBLIC_URL', () => {
    expect(deriveCustomerNameFromPublicUrl('https://demo-server.tower.example.com')).toBe('demo-server');
    expect(deriveCustomerNameFromPublicUrl('https://demo-org.tower.example.com/')).toBe('demo-org');
  });

  it('returns null for missing or invalid PUBLIC_URL', () => {
    expect(deriveCustomerNameFromPublicUrl('')).toBeNull();
    expect(deriveCustomerNameFromPublicUrl('not a url')).toBeNull();
  });

  it('prefers explicit customer env over PUBLIC_URL inference', () => {
    expect(resolveCurrentBudgetCustomer({ AI_TOKEN_BUDGET_CUSTOMER: 'openclaw-vm' } as any, 'https://demo-server.tower.example.com')).toBe('openclaw-vm');
    expect(resolveCurrentBudgetCustomer({ TOWER_CUSTOMER_NAME: 'demo-org' } as any, 'https://demo-server.tower.example.com')).toBe('demo-org');
    expect(resolveCurrentBudgetCustomer({ CUSTOMER_NAME: 'demo-server' } as any, 'https://demo-org.tower.example.com')).toBe('demo-server');
  });

  it('falls back to PUBLIC_URL inference when env is absent', () => {
    expect(resolveCurrentBudgetCustomer({} as any, 'https://demo-server.tower.example.com')).toBe('demo-server');
  });

  it('falls back to Tower DB rows only when LiteLLM SpendLogs are unavailable', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, './ai-token-budget.ts'), 'utf-8');
    expect(src).toContain('/spend/logs');
    expect(src).toContain('Tower API ledger filtered by this VM virtual key');
    expect(src).toContain("NULLIF(metadata->'usage'->>'cost_usd', '') IS NOT NULL");
    expect(src).toContain('Fallback: Tower DB message usage metadata');
  });
});
