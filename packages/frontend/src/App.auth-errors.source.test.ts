import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('routes login, OTP, email enrollment, and signup failures through the localized account boundary', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  for (const [start, finish] of [
    ['const handleLogin =', 'const handleLoginOtp ='],
    ['const handleLoginOtp =', 'const handleEmailEnrollment ='],
    ['const handleEmailEnrollment =', 'const handleSignup ='],
    ['const handleSignup =', 'const handleSelectSession ='],
  ]) {
    const block = source.slice(source.indexOf(start), source.indexOf(finish));
    expect(block).toContain('authErrorMessage(data.error, data.code)');
    expect(block).not.toMatch(/setAuthError\(data\.error|message: data\.error|setAuthError\('Unexpected/);
  }
  // Preserve enrollment control-flow decisions; localization must not advance a failed email request.
  expect(source).toContain("const unavailable = action==='email' && data.error==='Email address is unavailable'");
  expect(source).toContain("if ((res.status===404 || res.status===410) && !unavailable) setEmailEnrollmentChallenge(null)");
});
