import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, 'hooks/useSessionStartup.ts'), 'utf8');
const lookup = fs.readFileSync(path.resolve(__dirname, 'hooks/session-link-resolution.ts'), 'utf8');

describe('shared Session short-code deep links', () => {
  it('fetches an accessible Session by short code when it is absent from the local list', () => {
    expect(source).toContain('await lookupSessionLink(initialUrl.sessionKey, headers)');
    expect(lookup).toContain('fetch(`/api/sessions/${encodeURIComponent(key)}`, { headers, signal })');
    expect(source).not.toContain('UUID 만 shared session fetch');
    expect(source).not.toContain('short_code 는 내부 세션 식별용이라 로컬 목록에 *반드시* 있어야 함');
  });

  it('distinguishes forbidden, missing, authentication, and unavailable deep links', () => {
    expect(lookup).toContain("response.status === 403");
    expect(lookup).toContain("response.status === 401");
    expect(lookup).toContain("response.status !== 404");
    expect(source).toContain('setSessionLinkState(result)');
    expect(lookup).toContain("kind: 'forbidden'");
    expect(lookup).toContain("kind: 'not_found'");
    expect(lookup).toContain("kind: 'authentication_required'");
    expect(lookup).toContain("kind: 'unavailable'");
  });
});
