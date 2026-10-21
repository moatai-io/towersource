import type { AccountMailMessage, AccountMailProvider, AccountMailReadiness, AccountMailSendResult } from './types.js';
import { ResendAccountMailProvider } from './resend-provider.js';
import { GatewayResendAccountMailProvider } from './gateway-resend-provider.js';

class UnconfiguredAccountMailProvider implements AccountMailProvider {
  readonly name = 'unconfigured';

  async send(_message: AccountMailMessage): Promise<AccountMailSendResult> {
    throw new Error('Account mail provider is not configured');
  }

  async checkConnection(): Promise<AccountMailReadiness> {
    return { configured: false, connection: 'unconfigured' };
  }
}

function providerFromEnvironment(env: NodeJS.ProcessEnv): AccountMailProvider {
  if (!env.TOWER_MAIL_PROVIDER) return new UnconfiguredAccountMailProvider();
  if (env.TOWER_MAIL_PROVIDER === 'gateway-resend') return new GatewayResendAccountMailProvider({
    credentialId: env.TOWER_ACCOUNT_MAIL_CREDENTIAL_ID || '', baseUrl: env.TOWER_ACCOUNT_MAIL_GATEWAY_URL || '', keyFile: env.TOWER_ACCOUNT_MAIL_KEY_FILE || '', sourceRoot: env.TOWER_RUNTIME_CWD || process.cwd(), from: env.TOWER_MAIL_FROM || '',
  });
  if (env.TOWER_MAIL_PROVIDER !== 'resend') throw new Error('Unsupported TOWER_MAIL_PROVIDER');
  return new ResendAccountMailProvider({
    apiKey: env.RESEND_API_KEY || '', from: env.TOWER_MAIL_FROM || '',
    replyTo: env.TOWER_MAIL_REPLY_TO || undefined,
  });
}

let provider: AccountMailProvider = providerFromEnvironment(process.env);

export function getAccountMailProvider(): AccountMailProvider {
  return provider;
}

/** Test seam. Production Resend is selected only with explicit TOWER_MAIL_PROVIDER=resend configuration. */
export function setAccountMailProvider(next: AccountMailProvider): void {
  provider = next;
}

export function resetAccountMailProvider(): void {
  provider = providerFromEnvironment(process.env);
}
