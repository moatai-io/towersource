import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

describe('Admin organization Google Connection UX', () => {
  it('starts organization OAuth with an exact workspace Credential ID', () => {
    expect(source).toContain("credentialId ? `?mode=reauth&credentialId=");
    expect(source).toContain(": '?mode=create'");
    expect(source).not.toContain('organizationGoogleId');
    expect(source).toContain('Google 계정으로 연결');
    expect(source).toContain('조직 공용 Google Workspace 연결');
  });

  it('reauthenticates an existing Google OAuth Credential instead of exposing raw rotation', () => {
    expect(source).toContain("credential.allowedActions?.replacementAction === 'reauth'");
    expect(source).toContain("credential.provider === 'google'");
    expect(source).toContain('connectOrganizationGoogle(credential.id)');
    expect(source).toContain('mode=reauth');
    expect(source).toContain('조직 계정 재인증');
  });

  it('does not expose the legacy personal OAuth path in global Admin Connections', () => {
    const globalSection = source.slice(source.indexOf("!isPersonalCredentialMode ? ("), source.indexOf("{selectedConnection && isAdmin"));
    expect(globalSection).not.toContain('내 Google Workspace 연결');
    expect(source).not.toContain('기존 개인 OAuth provider 상태 보기');
  });

  it('reports that Agent grants remain unchanged and refreshes after callback', () => {
    expect(source).toContain("params.get('oauth') !== 'google-organization'");
    expect(source).toContain('기존 Agent 권한은 유지됩니다.');
    expect(source).toContain('void fetchAll()');
    expect(source).toContain('조직 Google Workspace Connection을 저장하지 못했습니다. 다시 시도해 주세요.');
  });
});
