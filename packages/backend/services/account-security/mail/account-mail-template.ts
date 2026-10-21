/** Controlled account-mail contract. Keep this file in sync with the Gateway copy. */
export type AccountMailTemplate =
  | { version: 1; kind: 'account_invitation'; origin: string; token: string }
  | { version: 1; kind: 'email_verification'; origin: string; token: string }
  | { version: 1; kind: 'login_otp'; variant: 'login' | 'enrollment'; code: string }
  | { version: 1; kind: 'password_reset'; origin: string; token: string }
  | { version: 1; kind: 'password_changed_notice' };

const own = (value: object, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
function origin(value: unknown, allowLocal: boolean): string {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value) || value.length > 2048) throw new Error('Invalid account mail origin');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Invalid account mail origin'); }
  if ((parsed.protocol !== 'https:' && !(allowLocal && parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) ||
      !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || (parsed.origin !== value && parsed.origin + '/' !== value) ||
      (parsed.protocol === 'https:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('Invalid account mail origin');
  return parsed.origin;
}
export function validateAccountMailTemplate(value: unknown, allowLocal = false): AccountMailTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid account mail template');
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error('Invalid account mail template');
  if (item.kind === 'password_changed_notice' && own(item, ['version', 'kind'])) return item as unknown as AccountMailTemplate;
  if (item.kind === 'login_otp' && own(item, ['version', 'kind', 'variant', 'code']) &&
      (item.variant === 'login' || item.variant === 'enrollment') && typeof item.code === 'string' && /^\d{6}$/.test(item.code)) return item as unknown as AccountMailTemplate;
  if (['account_invitation', 'email_verification', 'password_reset'].includes(String(item.kind)) && own(item, ['version', 'kind', 'origin', 'token']) &&
      typeof item.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(item.token)) {
    origin(item.origin, allowLocal);
    return item as unknown as AccountMailTemplate;
  }
  throw new Error('Invalid account mail template');
}

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function renderAccountMailTemplate(value: unknown, allowLocal = false): { subject: string; text: string; html: string } {
  const template = validateAccountMailTemplate(value, allowLocal);
  const spec = (() => {
    switch (template.kind) {
      case 'account_invitation': return { subject: 'Tower 계정 초대', heading: 'Tower 계정에 초대되었습니다', description: '로그인 ID와 비밀번호를 설정해 계정을 사용하세요.', action: '계정 설정하기', expiry: '이 링크는 72시간 동안 유효합니다.', safety: '초대를 예상하지 못했다면 관리자에게 문의하세요.', url: `${origin(template.origin, allowLocal)}/?accountInvitation=${encodeURIComponent(template.token)}` };
      case 'email_verification': return { subject: 'Tower 계정 이메일 확인', heading: '계정 이메일을 확인하세요', description: '이 주소를 Tower 계정 이메일로 확인합니다.', action: '이메일 확인하기', expiry: '이 링크는 24시간 동안 유효합니다.', safety: '요청하지 않았다면 관리자에게 문의하세요.', url: `${origin(template.origin, allowLocal)}/?accountEmailVerification=${encodeURIComponent(template.token)}` };
      case 'login_otp': return template.variant === 'enrollment'
        ? { subject: 'Tower 기존 계정 이메일 등록 코드', heading: '계정 이메일 등록 코드', description: '이 코드는 계정 이메일 등록과 첫 로그인에만 사용됩니다.', action: '', expiry: '10분 안에 코드를 입력하세요. 가장 최근에 받은 코드만 유효합니다.', safety: '요청하지 않았다면 코드를 공유하지 말고 관리자에게 문의하세요.', code: template.code }
        : { subject: 'Tower 로그인 인증 코드', heading: '로그인 인증 코드', description: 'Tower 로그인 화면에 아래 코드를 입력하세요.', action: '', expiry: '10분 안에 코드를 입력하세요. 가장 최근에 받은 코드만 유효합니다.', safety: '요청하지 않았다면 코드를 공유하지 말고 관리자에게 문의하세요.', code: template.code };
      case 'password_reset': return { subject: 'Tower 비밀번호 재설정', heading: '비밀번호를 재설정하세요', description: 'Tower 계정의 비밀번호 재설정 요청을 받았습니다.', action: '새 비밀번호 설정하기', expiry: '이 링크는 30분 동안 유효합니다.', safety: '요청하지 않았다면 이 메일을 무시하세요. 비밀번호는 변경되지 않습니다.', url: `${origin(template.origin, allowLocal)}/?passwordReset=${encodeURIComponent(template.token)}` };
      case 'password_changed_notice': return { subject: 'Tower 비밀번호 변경 안내', heading: '비밀번호가 변경되었습니다', description: 'Tower 계정의 비밀번호가 변경되었습니다.', action: '', expiry: '', safety: '본인이 변경하지 않았다면 관리자에게 즉시 문의하세요.' };
    }
  })();
  const text = [spec.heading, spec.description, 'code' in spec ? spec.code : '', 'url' in spec ? `${spec.action}\n${spec.url}` : '', spec.expiry, spec.safety, 'Tower 계정 안내 · 도움이 필요하면 Tower 관리자에게 문의하세요. 이 메일에 회신하지 마세요.'].filter(Boolean).join('\n\n');
  const detail = 'code' in spec ? `<p class="mail-code" style="margin:24px 0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:6px;color:#172b40">${escape(spec.code!)}</p>` :
    'url' in spec ? `<p style="margin:28px 0"><a href="${escape(spec.url!)}" class="mail-cta" style="display:inline-block;background:#165e79;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:5px">${escape(spec.action)}</a></p><p class="mail-muted" style="font-size:13px;line-height:1.6;color:#44596a">버튼이 열리지 않으면 아래 주소를 복사해 브라우저에 붙여 넣으세요.<br><a href="${escape(spec.url!)}" class="mail-link" style="color:#165e79;word-break:break-all">${escape(spec.url!)}</a></p>` : '';
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>:lang(ko){word-break:keep-all;overflow-wrap:break-word}@media(prefers-color-scheme:dark){.mail-body,.mail-frame{background:#152736!important}.mail-card{background:#1c3447!important}.mail-ink,.mail-code{color:#f0f5f8!important}.mail-copy,.mail-muted{color:#c8d7e2!important}.mail-link{color:#8bd3eb!important}.mail-cta{background:#8bd3eb!important;color:#152736!important}}</style><title>${escape(spec.subject)}</title></head><body class="mail-body" style="margin:0;padding:0;background:#edf2f5;color:#172b40;word-break:keep-all;overflow-wrap:break-word;font-family:Arial,'Apple SD Gothic Neo',sans-serif"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="mail-frame" style="border-collapse:collapse;background:#edf2f5"><tr><td align="center" style="padding:24px 16px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="mail-card" style="max-width:560px;border-collapse:collapse;background:#ffffff"><tr><td class="mail-ink" style="padding:24px 28px;border-top:2px solid #165e79;font-size:16px;font-weight:700;color:#172b40">Tower <span class="mail-muted" style="font-size:12px;font-weight:400;color:#44596a">계정 안내</span></td></tr><tr><td style="padding:8px 28px 30px"><h1 class="mail-ink" style="margin:0 0 16px;font-size:24px;line-height:1.4;color:#172b40">${escape(spec.heading)}</h1><p class="mail-copy" style="margin:0;font-size:16px;line-height:1.7;color:#263f52">${escape(spec.description)}</p>${detail}${spec.expiry ? `<p class="mail-muted" style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#44596a">${escape(spec.expiry)}</p>` : ''}<p class="mail-muted" style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#44596a">${escape(spec.safety)}</p></td></tr><tr><td class="mail-muted" style="padding:18px 28px;border-top:1px solid #d6e1e8;font-size:12px;line-height:1.6;color:#44596a">Tower 계정 안내 · 도움이 필요하면 Tower 관리자에게 문의하세요. 이 메일에 회신하지 마세요.</td></tr></table></td></tr></table></body></html>`;
  return { subject: spec.subject, text, html };
}

/** Sender adapters receive the same rendered content, while Gateway reconstructs it from semantic fields. */
export function composeAccountMail(template: AccountMailTemplate, to: string, idempotencyKey: string, allowLocal = false) {
  return { kind: template.kind, to, ...renderAccountMailTemplate(template, allowLocal), template, idempotencyKey };
}
