import { renderAccountMailTemplate } from './account-mail-template.js';
import type { AccountMailMessage, AccountMailProvider, AccountMailReadiness, AccountMailSendResult } from './types.js';
import { resolveAccountMailCredential } from './account-mail-credential.js';
import { readServerMailVirtualKey } from './server-mail-key.js';

/** Server-only mail transport; the virtual key is not a Resend provider credential. */
export class GatewayResendAccountMailProvider implements AccountMailProvider {
  readonly name = 'gateway-resend';
  constructor(private readonly options: { baseUrl: string; credentialId?: string; keyFile: string; sourceRoot: string; from: string; fetcher?: typeof fetch }) {}

  private async readKey(): Promise<string> {
    if (this.options.credentialId && this.options.keyFile) throw new Error('Ambiguous account mail Credential configuration');
    return this.options.credentialId
      ? resolveAccountMailCredential(this.options.credentialId)
      : readServerMailVirtualKey(this.options.keyFile, this.options.sourceRoot);
  }

  async checkConnection(): Promise<AccountMailReadiness> {
    const configured = Boolean(this.options.baseUrl && (this.options.credentialId || this.options.keyFile) && this.options.from);
    if (!configured) return { configured: false, connection: 'unconfigured' };
    try {
      await this.readKey();
      return { configured: true, connection: 'ok', detail: 'local configuration only; delivery unverified' };
    } catch { return { configured: false, connection: 'unconfigured' }; }
  }

  async send(message: AccountMailMessage): Promise<AccountMailSendResult> {
    if (!this.options.baseUrl || !this.options.from || !(this.options.credentialId || this.options.keyFile)) throw new Error('Gateway account mail provider is not configured');
    const url = new URL(this.options.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || url.pathname !== '/account-mail/emails') {
      throw new Error('Gateway account mail URL is invalid');
    }
    if (message.template) {
      if (message.template.kind !== message.kind) throw new Error('Gateway account mail kind mismatch');
      const rendered = renderAccountMailTemplate(message.template);
      if (message.subject !== rendered.subject || message.text !== rendered.text || message.html !== rendered.html) throw new Error('Gateway account mail body mismatch');
    } else if (message.html) throw new Error('Gateway account mail does not accept HTML');
    const virtualKey = await this.readKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await (this.options.fetcher ?? fetch)(url.toString(), {
        method: 'POST', signal: controller.signal, redirect: 'error',
        headers: {
          Authorization: `Bearer ${virtualKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify(message.template
          ? { kind: message.kind, from: this.options.from, to: [message.to], template: message.template }
          : { kind: message.kind, from: this.options.from, to: [message.to], subject: message.subject, text: message.text }),
      });
      if (!response.ok) throw new Error(`Gateway account mail delivery failed (HTTP ${response.status})`);
      const result = await response.json() as { id?: unknown };
      if (typeof result.id !== 'string' || !result.id || result.id.length > 200) throw new Error('Gateway account mail response omitted message ID');
      return { providerMessageId: result.id };
    } finally { clearTimeout(timer); }
  }
}
