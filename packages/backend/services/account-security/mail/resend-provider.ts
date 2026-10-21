import { renderAccountMailTemplate } from './account-mail-template.js';
import type { AccountMailMessage, AccountMailProvider, AccountMailReadiness, AccountMailSendResult } from './types.js';

export class ResendAccountMailProvider implements AccountMailProvider {
  readonly name = 'resend';
  constructor(private readonly options: { apiKey: string; from: string; replyTo?: string; fetcher?: typeof fetch }) {}

  async checkConnection(): Promise<AccountMailReadiness> {
    // Resend has no zero-side-effect send verification. A local check is not provider auth or DNS validation.
    const configured = Boolean(this.options.apiKey && this.options.from);
    return { configured, connection: configured ? 'ok' : 'unconfigured', detail: configured ? 'local configuration only; delivery unverified' : undefined };
  }

  async send(message: AccountMailMessage): Promise<AccountMailSendResult> {
    if (!this.options.apiKey || !this.options.from) throw new Error('Resend mail provider is not configured');
    const rendered = message.template ? renderAccountMailTemplate(message.template, process.env.NODE_ENV === 'test') : null;
    if (rendered && (message.kind !== message.template?.kind || message.subject !== rendered.subject || message.text !== rendered.text || message.html !== rendered.html)) throw new Error('Account mail body mismatch');
    if (message.html && !message.template) throw new Error('Account mail does not accept arbitrary HTML');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await (this.options.fetcher ?? fetch)('https://api.resend.com/emails', {
        method: 'POST', signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.options.from, to: [message.to], subject: message.subject,
          text: message.text, ...(message.html ? { html: message.html } : {}),
          ...(this.options.replyTo ? { reply_to: this.options.replyTo } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Resend mail delivery failed (HTTP ${response.status})`);
      const result = await response.json() as { id?: string };
      if (!result.id) throw new Error('Resend mail delivery response omitted message ID');
      return { providerMessageId: result.id };
    } finally { clearTimeout(timer); }
  }
}
