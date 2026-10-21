import type { AccountMailTemplate } from './account-mail-template.js';
export type AccountMailKind = 'account_invitation' | 'email_verification' | 'login_otp' | 'password_reset' | 'password_changed_notice';

export interface AccountMailMessage {
  kind: AccountMailKind;
  to: string;
  subject: string;
  text: string;
  html?: string;
  template?: AccountMailTemplate;
  idempotencyKey: string;
}

export interface AccountMailSendResult {
  providerMessageId: string | null;
}

export interface AccountMailReadiness {
  configured: boolean;
  connection: 'ok' | 'unconfigured' | 'error';
  detail?: string;
}

export interface AccountMailProvider {
  readonly name: string;
  send(message: AccountMailMessage): Promise<AccountMailSendResult>;
  checkConnection(): Promise<AccountMailReadiness>;
}
