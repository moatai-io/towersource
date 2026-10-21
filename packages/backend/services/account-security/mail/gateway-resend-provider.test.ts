import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayResendAccountMailProvider } from './gateway-resend-provider.js';
import { getAccountMailProvider, resetAccountMailProvider } from './mail-service.js';
const message = { kind: 'email_verification' as const, to: 'user@example.com', subject: 'Verify', text: 'Link', idempotencyKey: 'verification:123' };
let root = '';
let opts: { baseUrl: string; keyFile: string; sourceRoot: string; from: string };
async function setup() { root = await mkdtemp(join(tmpdir(), 'gateway-mail-test-')); const sourceRoot = join(root, 'source'); await mkdir(sourceRoot); const keyFile = join(root, 'mail.key'); await writeFile(keyFile, 'synthetic-virtual-key', { mode: 0o600 }); opts = { baseUrl: 'https://gateway.example.com/account-mail/emails', keyFile, sourceRoot, from: 'no-reply@example.com' }; }
afterEach(async () => { vi.unstubAllEnvs(); resetAccountMailProvider(); if (root) await rm(root, { recursive: true, force: true }); root = ''; });
describe('Gateway account mail provider', () => {
  it('sends only a virtual key and bounded payload to the fixed route', async () => {
    await setup();
    const fetcher = vi.fn(async () => Response.json({ id: 'mail-1' }));
    const provider = new GatewayResendAccountMailProvider({ ...opts, fetcher });
    expect(await provider.send(message)).toEqual({ providerMessageId: 'mail-1' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(opts.baseUrl);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer synthetic-virtual-key', 'Idempotency-Key': 'verification:123' } });
    expect(JSON.parse(init.body as string)).toEqual({ kind: message.kind, from: opts.from, to: [message.to], subject: message.subject, text: message.text });
  });
  it('rejects unsafe URLs, HTML, missing key, and provider errors without response body', async () => {
    await setup();
    const fetcher = vi.fn(async () => new Response('private provider error', { status: 403 }));
    await expect(new GatewayResendAccountMailProvider({ ...opts, baseUrl: 'http://gateway.example.com/account-mail/emails', fetcher }).send(message)).rejects.toThrow('URL is invalid');
    await expect(new GatewayResendAccountMailProvider({ ...opts, baseUrl: 'https://api.resend.com/emails', fetcher }).send(message)).rejects.toThrow('URL is invalid');
    await expect(new GatewayResendAccountMailProvider({ ...opts, keyFile: '', fetcher }).send(message)).rejects.toThrow('not configured');
    await expect(new GatewayResendAccountMailProvider({ ...opts, fetcher }).send({ ...message, html: '<b>x</b>' })).rejects.toThrow('does not accept HTML');
    await expect(new GatewayResendAccountMailProvider({ ...opts, fetcher }).send(message)).rejects.toThrow('HTTP 403');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('selects the gateway provider only when explicitly configured', async () => {
    await setup();
    vi.stubEnv('TOWER_MAIL_PROVIDER', 'gateway-resend');
    vi.stubEnv('TOWER_ACCOUNT_MAIL_CREDENTIAL_ID', '');
    vi.stubEnv('TOWER_ACCOUNT_MAIL_GATEWAY_URL', opts.baseUrl);
    vi.stubEnv('TOWER_ACCOUNT_MAIL_KEY_FILE', opts.keyFile);
    vi.stubEnv('TOWER_RUNTIME_CWD', opts.sourceRoot);
    vi.stubEnv('TOWER_MAIL_FROM', opts.from);
    resetAccountMailProvider();
    expect(getAccountMailProvider().name).toBe('gateway-resend');
    expect(await getAccountMailProvider().checkConnection()).toMatchObject({ configured: true, connection: 'ok' });
  });
});

describe('controlled template sender parity', () => {
  it('sends semantic fields only and rejects any caller body mismatch before transport', async () => {
    await setup();
    const { composeAccountMail } = await import('./account-mail-template.js');
    const { ResendAccountMailProvider } = await import('./resend-provider.js');
    const composed = composeAccountMail({ version: 1, kind: 'password_reset', origin: 'https://tower.example.com', token: 'a'.repeat(43) }, 'user@example.com', 'reset:synthetic');
    const gatewayFetch = vi.fn(async () => Response.json({ id: 'gateway-mail' }));
    const directFetch = vi.fn(async () => Response.json({ id: 'direct-mail' }));
    const gateway = new GatewayResendAccountMailProvider({ ...opts, fetcher: gatewayFetch });
    const direct = new ResendAccountMailProvider({ apiKey: 'synthetic-only', from: opts.from, fetcher: directFetch });
    await gateway.send(composed); await direct.send(composed);
    const gatewayBody = JSON.parse(String((gatewayFetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));
    const directBody = JSON.parse(String((directFetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));
    expect(gatewayBody).toEqual({ kind: 'password_reset', from: opts.from, to: [composed.to], template: composed.template });
    expect(directBody).toEqual({ from: opts.from, to: [composed.to], subject: composed.subject, text: composed.text, html: composed.html });
    for (const bad of [{ ...composed, html: '<p>forged</p>' }, { ...composed, text: 'forged' }, { ...composed, subject: 'forged' }, { ...composed, kind: 'email_verification' as const }]) {
      await expect(gateway.send(bad)).rejects.toThrow(); await expect(direct.send(bad)).rejects.toThrow();
    }
    expect(gatewayFetch).toHaveBeenCalledTimes(1); expect(directFetch).toHaveBeenCalledTimes(1);
  });
});
