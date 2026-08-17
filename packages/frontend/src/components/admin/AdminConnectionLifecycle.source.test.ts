import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

describe('Admin Connection lifecycle UX', () => {
  it('offers plain-language rename, reconnect, safe disconnect, and restore actions', () => {
    expect(source).toContain('Connection 이름');
    expect(source).toContain('이름 저장');
    expect(source).toContain('Google 계정 다시 연결');
    expect(source).toContain('안전하게 연결 끊기');
    expect(source).toContain('연결 복구');
    expect(source).toContain('/connection`');
  });

  it('explains safe disconnect impact and policy preservation before mutation', () => {
    expect(source).toContain('암호화된 저장값과 Agent별 허용·차단 정책은 복구를 위해 보존됩니다.');
    expect(source).toContain("confirmLabel: '안전하게 연결 끊기'");
  });

  it('removes manual provider probe from the Agent permission surface', () => {
    const agents = source.slice(source.indexOf("connectionDetailTab === 'agents'"), source.indexOf("connectionDetailTab === 'advanced'", source.indexOf("connectionDetailTab === 'agents'")));
    expect(agents).not.toContain('연결 테스트');
    expect(agents).not.toContain('probeConnectionProject');
  });

  it('moves raw reveal and structure inspection into the advanced tab', () => {
    const advanced = source.slice(source.indexOf("connectionDetailTab === 'advanced'"), source.indexOf("connectionDetailTab === 'agents'"));
    expect(advanced).toContain('고급 Credential 관리');
    expect(advanced).toContain('원문 보기');
    expect(advanced).toContain('구조 보기');
  });
});
