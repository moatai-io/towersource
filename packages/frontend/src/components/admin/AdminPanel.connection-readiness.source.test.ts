import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'AdminPanel.tsx'), 'utf8');

describe('Connection-centered management UI contract', () => {
  it('does not present project grant as verified Provider readiness', () => {
    expect(source).toContain("'connected_unverified'");
    expect(source).toContain("adminText('credentialConnections.readiness.connectedUnverified')");
    expect(source).toContain("adminText('credentialConnections.readiness.connectedUnverifiedDescription'");
    expect(source).not.toContain("if (status === 'connected') return { label: '정상 사용 가능'");
  });

  it('uses a service Connection as the primary user-facing surface', () => {
    expect(source).toContain("renderTab('credentials', t('connectionsTab'))");
    expect(source).toContain("adminText('credentialConnections.readiness.connectedUnverified')");
    expect(source).toContain('connectionPrimaryAction');
    expect(source).toContain('connectionPrimaryAction');
  });

  it('keeps one primary management action and hides low-level credential operations by default', () => {
    expect(source).toContain('고급 Credential 관리');
    expect(source).toContain('showAdvanced && !isPersonalCredentialMode');
    expect(source).toContain('handleConnectionPrimaryAction');
    expect(source).toContain("return { label: adminText('credentialConnections.primaryAction'), kind: 'detail' as const }");
    expect(source).not.toContain("label: '연결 확인'");
  });

  it('uses a comparable desktop table and a compact mobile list', () => {
    expect(source).toContain('hidden overflow-x-auto md:block');
    expect(source).toContain('w-full min-w-[920px]');
    expect(source).toContain('divide-y divide-surface-800/60 md:hidden');
    expect(source).toContain("<th className=\"px-4 py-2.5 text-left font-semibold\">{t('credentialConnections.service')}</th>");
    expect(source).toContain("<th className=\"px-4 py-2.5 text-left font-semibold\">{t('credentialConnections.providerAuth')}</th>");
    expect(source).toContain('min-h-11 flex-1');
    expect(source).not.toContain('xl:grid-cols-3 gap-3 p-4');
  });

  it('makes the single management action open the Connection management flow', () => {
    expect(source).toContain('handleConnectionPrimaryAction');
    expect(source).toContain('openConnectionDetail(connection.id)');
    expect(source).not.toContain('copyText(askPrompt)');
    expect(source).not.toContain('>상세 보기</button>');
    expect(source).not.toContain('>상세</button>');
  });

  it('opens a responsive right drawer with two focused areas', () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('md:max-w-[560px]');
    expect(source).toContain("'management' | 'agents'");
    expect(source).toContain("['management', t('credentialConnections.managementTab')]");
    expect(source).toContain("['agents', t('credentialConnections.agentsTab')]");
    expect(source).not.toContain("['summary', '요약']");
    expect(source).not.toContain("['diagnostics', '진단']");
    expect(source).toContain("if (event.key === 'Escape') closeConnectionDetail()");
    expect(source).toContain('connectionDetailTriggerRef.current?.focus()');
    expect(source).not.toContain('ref={selectedConnectionRef}');
  });

  it('keeps Credential values hidden while exposing only safe structure and identifiers', () => {
    expect(source).toContain('Credential 관리');
    expect(source).toContain('구조화 Credential은 민감 필드를 제외한 구조만 검사할 수 있습니다.');
    expect(source).toContain('기술 이름 보기');
    expect(source).not.toContain('credential.secretValue');
  });

  it('adds ephemeral reveal and structure inspection without persistent storage', () => {
    expect(source).toContain('원문 보기');
    expect(source).toContain('구조 보기');
    expect(source).toContain("cache: 'no-store'");
    expect(source).toContain("document.addEventListener('visibilitychange', handleVisibility)");
    expect(source).toContain('setCredentialRevealValue(null)');
    expect(source).not.toContain('localStorage.setItem');
    expect(source).not.toContain('sessionStorage.setItem');
  });

  it('exposes the safe actions allowed by the backend reveal policy', () => {
    expect(source).toContain('credential.allowedActions?.reveal !== false');
    expect(source).toContain("credential.allowedActions?.replacementAction === 'rotate'");
    expect(source).toContain('OAuth token은 원문을 표시하지 않습니다.');
    expect(source).toContain('SSH private key는 원문을 표시하지 않습니다.');
    expect(source).toContain('구조화 Credential은 민감 필드를 제외한 구조만 검사할 수 있습니다.');
    expect(source).toContain('구조 보기');
  });

  it('rotates through no-store preview and exact confirmed apply while preserving project grants', () => {
    expect(source).toContain('/rotate/preview`');
    expect(source).toContain('/rotate/apply`');
    expect(source).toContain('기존 Credential ID와 프로젝트 연결을 유지');
    expect(source).toContain('영향 확인 후 교체');
    expect(source).toContain('confirmed: true');
  });

  it('uses exact preview and apply for project Connection changes', () => {
    expect(source).toContain("/preview`");
    expect(source).toContain("/apply`");
    expect(source).toContain('proposalHash: preview.proposalHash');
    expect(source).toContain('confirmed: true');
    expect(source).toContain('서비스 연결 승인');
  });

  it('guides the agent with the same safe Connection vocabulary', () => {
    expect(source).toContain('실제 Provider 사용 가능 여부를 구분');
    expect(source).toContain('다음 행동 하나');
    expect(source).toContain('present만으로 성공 판정하지 말고');
    expect(source).toContain('secret, token, env 이름, 파일 경로는 출력하지 마');
  });
});
