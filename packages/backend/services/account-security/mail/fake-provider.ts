import type { AccountMailMessage, AccountMailProvider, AccountMailReadiness, AccountMailSendResult } from './types.js';

export class FakeAccountMailProvider implements AccountMailProvider {
  readonly name = 'fake';
  readonly sent: AccountMailMessage[] = [];

  async send(message: AccountMailMessage): Promise<AccountMailSendResult> {
    this.sent.push(structuredClone(message));
    return { providerMessageId: `fake-${this.sent.length}` };
  }

  async checkConnection(): Promise<AccountMailReadiness> {
    return { configured: true, connection: 'ok' };
  }
}
