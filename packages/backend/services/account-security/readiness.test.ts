import { describe, expect, it } from 'vitest';
import { calculateAccountEmailReadiness } from './readiness.js';

describe('account email readiness', () => {
  it('requires every active account to have a verified email and a healthy provider', () => {
    expect(calculateAccountEmailReadiness({
      policy: 'required', activeAccounts: 12, verifiedActiveAccounts: 10,
      mailProviderConfigured: true, providerConnection: 'ok',
    })).toMatchObject({
      ready: false, unreadyAccounts: 2, blockers: ['ACTIVE_EMAIL_COVERAGE_INCOMPLETE'],
    });
  });

  it('reports provider blockers without silently changing policy', () => {
    expect(calculateAccountEmailReadiness({
      policy: 'required', activeAccounts: 2, verifiedActiveAccounts: 2,
      mailProviderConfigured: false, providerConnection: 'unconfigured',
    })).toMatchObject({
      policy: 'required', ready: false, blockers: ['MAIL_PROVIDER_UNCONFIGURED'],
    });
  });

  it('is ready only when all required evidence is present', () => {
    expect(calculateAccountEmailReadiness({
      policy: 'required', activeAccounts: 2, verifiedActiveAccounts: 2,
      mailProviderConfigured: true, providerConnection: 'ok',
    }).ready).toBe(true);
  });
});

it('only exempts explicit cutoff-eligible missing-email accounts while keeping mail and outside-cutoff gates',()=>{
  const base={policy:'required' as const,activeAccounts:4,verifiedActiveAccounts:2,enrollableActiveAccounts:2,mailProviderConfigured:true,providerConnection:'ok' as const};
  expect(calculateAccountEmailReadiness(base).ready).toBe(true);
  expect(calculateAccountEmailReadiness({...base,enrollableActiveAccounts:1}).ready).toBe(false);
  expect(calculateAccountEmailReadiness({...base,providerConnection:'error'}).ready).toBe(false);
});
