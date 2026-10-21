import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
const gatewayTemplatePath = new URL('../../../../../work/api-router-tower/modules/account-mail-template.ts', import.meta.url);
import { composeAccountMail, renderAccountMailTemplate, validateAccountMailTemplate, type AccountMailTemplate } from './account-mail-template.js';
const token = 'a'.repeat(43);
const origin = 'https://tower.example.com';
const samples: AccountMailTemplate[] = [
  { version: 1, kind: 'account_invitation', origin, token },
  { version: 1, kind: 'email_verification', origin, token },
  { version: 1, kind: 'login_otp', variant: 'login', code: '123456' },
  { version: 1, kind: 'login_otp', variant: 'enrollment', code: '123456' },
  { version: 1, kind: 'password_reset', origin, token },
  { version: 1, kind: 'password_changed_notice' },
];
describe('controlled account mail templates', () => {
  it.each(samples)('renders matching text and HTML for $kind', (sample) => {
    const rendered = renderAccountMailTemplate(sample);
    const composed = composeAccountMail(sample, 'user@example.com', 'synthetic:1');
    expect(composed).toMatchObject(rendered);
    expect(rendered.html).toContain('<table role="presentation"');
    expect(rendered.html).toContain('Tower 계정 안내');
    expect(rendered.text).toContain('Tower 계정 안내');
    expect(rendered.html).not.toMatch(/<img|<script|@import|https?:\/\/[^"<>]*\.(?:png|woff)/i);
    if ('token' in sample) {
      expect(rendered.text).toContain(sample.token);
      expect(rendered.html).toContain(sample.token);
      expect(rendered.html).toContain('href="https://tower.example.com/');
    }
    if (sample.kind === 'login_otp') { expect(rendered.text).toContain('123456'); expect(rendered.html).toContain('123456'); expect(rendered.text).toContain('10분'); }
  });
  it('keeps each expiry aligned with issued capability', () => {
    expect(renderAccountMailTemplate(samples[0]).text).toContain('72시간');
    expect(renderAccountMailTemplate(samples[1]).text).toContain('24시간');
    expect(renderAccountMailTemplate(samples[4]).text).toContain('30분');
    expect(renderAccountMailTemplate(samples[5]).text).not.toContain('유효');
  });
  it('rejects injection, ambiguous origins, extra fields and unsafe code', () => {
    for (const unsafe of ['http://tower.example.com', 'https://user:pass@tower.example.com', 'https://tower.example.com/path', 'https://tower.example.com/?x=1', 'https://tower.example.com/#x', 'https://tower.example.com/\n', 'https://tower.example.com\\@evil.example.com', 'javascript:alert(1)', 'https://tower.example.com:443']) {
      expect(() => validateAccountMailTemplate({ version: 1, kind: 'password_reset', origin: unsafe, token })).toThrow();
    }
    expect(() => validateAccountMailTemplate({ version: 1, kind: 'login_otp', variant: 'login', code: '<12345' })).toThrow();
    expect(() => validateAccountMailTemplate({ version: 1, kind: 'account_invitation', origin, token, html: '<img src=x>' })).toThrow();
    expect(() => validateAccountMailTemplate({ version: 1, kind: 'password_reset', origin, token: `${token}<` })).toThrow();
  });
  it('permits loopback HTTP only for explicit non-production rendering', () => {
    const local = { version: 1, kind: 'password_reset', origin: 'http://localhost:32354', token };
    expect(() => renderAccountMailTemplate(local)).toThrow();
    expect(renderAccountMailTemplate(local, true).text).toContain('http://localhost:32354/');
    expect(() => renderAccountMailTemplate({ ...local, origin: 'http://example.com' }, true)).toThrow();
  });
});

describe('release ownership and source TTL guards', () => {
  it.skipIf(!existsSync(gatewayTemplatePath))('keeps Gateway renderer byte-identical when the separate release checkout is available', async () => {
    const { readFileSync } = await import('node:fs');
    const backend = readFileSync(new URL('./account-mail-template.ts', import.meta.url), 'utf8').split('/** Sender adapters')[0].trim();
    const gateway = readFileSync(gatewayTemplatePath, 'utf8').trim();
    expect(gateway).toBe(backend);
  });
  it('guards issuance TTLs and account terminology alongside copy', async () => {
    const { readFileSync } = await import('node:fs');
    const account = readFileSync(new URL('../account-email-service.ts', import.meta.url), 'utf8');
    const reset = readFileSync(new URL('../password-reset-service.ts', import.meta.url), 'utf8');
    const otp = readFileSync(new URL('../login-otp-service.ts', import.meta.url), 'utf8');
    const enrollment = readFileSync(new URL('../login-email-enrollment.ts', import.meta.url), 'utf8');
    expect(account).toContain('INVITATION_TTL_MS = 72 * 60 * 60 * 1000');
    expect(account).toContain('VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000');
    expect(reset).toContain('TTL_MS = 30 * 60 * 1000');
    expect(otp).toContain('OTP_TTL_MS = 10 * 60 * 1000');
    expect(enrollment).toContain('ttl = 10 * 60_000');
  });
});
