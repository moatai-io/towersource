export type LoginEmailOtpPolicy = 'off' | 'required';

export interface AccountEmailReadinessInput {
  policy: LoginEmailOtpPolicy;
  activeAccounts: number;
  verifiedActiveAccounts: number;
  enrollableActiveAccounts?: number;
  mailProviderConfigured: boolean;
  providerConnection: 'ok' | 'unconfigured' | 'error';
}

export interface AccountEmailReadiness {
  policy: LoginEmailOtpPolicy;
  ready: boolean;
  activeAccounts: number;
  verifiedActiveAccounts: number;
  unreadyAccounts: number;
  mailProviderConfigured: boolean;
  providerConnection: AccountEmailReadinessInput['providerConnection'];
  blockers: string[];
}

export function calculateAccountEmailReadiness(input: AccountEmailReadinessInput): AccountEmailReadiness {
  const unreadyAccounts = Math.max(0, input.activeAccounts - input.verifiedActiveAccounts);
  const blockers: string[] = [];
  if (unreadyAccounts > (input.enrollableActiveAccounts ?? 0)) blockers.push('ACTIVE_EMAIL_COVERAGE_INCOMPLETE');
  if (!input.mailProviderConfigured) blockers.push('MAIL_PROVIDER_UNCONFIGURED');
  else if (input.providerConnection !== 'ok') blockers.push('MAIL_PROVIDER_UNAVAILABLE');

  return {
    ...input,
    unreadyAccounts,
    ready: blockers.length === 0,
    blockers,
  };
}
