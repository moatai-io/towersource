import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveCustomerNameFromPublicUrl, resolveCurrentBudgetCustomer, resolveLiteLlmManagementBaseUrl } from './ai-token-budget';

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

  it('separates managed inference and key-info listeners without changing generic URLs', () => {
    expect(resolveLiteLlmManagementBaseUrl('http://100.64.0.10:14003/v1', {} as any)).toBe('http://100.64.0.10:4000');
    expect(resolveLiteLlmManagementBaseUrl('https://router.example.com/v1', {} as any)).toBe('https://router.example.com');
    expect(resolveLiteLlmManagementBaseUrl('https://inference.example.com/v1', {
      LITELLM_MANAGEMENT_BASE_URL: 'https://management.example.com/v1/',
    } as any)).toBe('https://management.example.com');
  });

  it('falls back to Tower DB rows only when LiteLLM SpendLogs are unavailable', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, './ai-token-budget.ts'), 'utf-8');
    expect(src).toContain('/spend/logs');
    expect(src).toContain('Tower API ledger filtered by this VM virtual key');
    expect(src).toContain("NULLIF(metadata->'usage'->>'cost_usd', '') IS NOT NULL");
    expect(src).toContain('Fallback: Tower DB message usage metadata');
  });

  it('does not attribute pre-key local usage to the newly connected LiteLLM key', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, './ai-token-budget.ts'), 'utf-8');
    expect(src).toContain('usageSince: process.env.LITELLM_USAGE_SINCE');
    expect(src).toContain('created_at >= $2::timestamptz');
    expect(src).toContain('readLocalPiTokenUsageSummary(days, budgetRead.usageSince)');
  });
});
