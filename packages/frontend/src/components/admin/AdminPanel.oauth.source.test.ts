import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

describe('Personal Credential OAuth UI', () => {
  it('puts the primary Google action in the personal credential header', () => {
    expect(source).toContain("primaryOAuthProvider.status === 'not_connected' ? 'Google 계정 연결'");
    expect(source).toContain("'Google 연결 설정 필요'");
    expect(source).toContain("aria-disabled={!primaryOAuthProvider.configured}");
    expect(source).toContain("primaryOAuthProvider.status === 'reauth_required' ? 'Google 다시 로그인'");
    expect(source).toContain("'+ API 키 추가'");
    expect(source).toContain('connectOAuthProvider(primaryOAuthProvider)');
  });

  it('shows personal login accounts without exposing them in global Admin Connections', () => {
    expect(source).toContain('isPersonalCredentialMode && personalSection');
    expect(source).toContain('로그인 계정');
    expect(source).not.toContain('내 Google Workspace 연결');
    expect(source).toContain("provider.status === 'connected' ? '연결됨'");
    expect(source).toContain("provider.status === 'reauth_required' ? '다시 로그인 필요'");
    expect(source).toContain("provider.status === 'not_connected' ? '계정 연결'");
    expect(source).toContain("'설정 방법 확인'");
    expect(source).toContain('이 Tower 서버의 Google OAuth 설정이 아직 완료되지 않았습니다.');
  });

  it('keeps the personal page compact with connection and project tabs', () => {
    expect(source).toContain("const [personalSection, setPersonalSection] = useState<'connections' | 'projects'>('connections')");
    expect(source).toContain('연결과 상태');
    expect(source).toContain('프로젝트 권한');
    expect(source).toContain('max-h-72');
  });

  it('allows personal project policy changes to be saved by non-admin users', () => {
    expect(source).toContain("if ((!canManageGlobalCredentials && !isPersonalCredentialMode) || pendingAccessPolicies.length === 0) return;");
  });

  it('explains that personal credentials follow the requesting user, not one agent', () => {
    expect(source).toContain('다른 사용자가 같은 프로젝트의 AI 팀원을 사용해도 내 Credential은 전달되지 않습니다.');
    expect(source).toContain('허용한 프로젝트의 팀원·Helper');
    expect(source).toContain('Primary AI 팀원과 Helper Agent가');
    expect(source).toContain('내가 시작한 실행에서만');
    expect(source).toContain('외부에 배포된 AI Service에는 이 개인 Credential이 자동으로 전달되지 않습니다.');
  });

  it('keeps the broad connection picker for global management only', () => {
    expect(source).toContain("...(!isPersonalCredentialMode ? [");
    expect(source).toContain("title: 'OAuth 계정'");
  });
});
