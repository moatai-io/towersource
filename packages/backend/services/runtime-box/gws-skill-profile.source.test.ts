import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(new URL('../../../../skills/managed/gws/SKILL.md', import.meta.url), 'utf8');
const runtimeBoxDockerfile = readFileSync(
  new URL('../../sandbox-images/runtime-box-node22-python313/Dockerfile', import.meta.url),
  'utf8',
);

describe('managed gws profile contract', () => {
  it('uses the requesting user personal profile for personal Workspace actions', () => {
    expect(skill).toContain('사용자 자신의 Gmail·Calendar·Drive 요청에는 모든 명령 앞에 `GWS_PROFILE=personal`');
    expect(skill).toContain('프로필을 생략하면 프로젝트 공용 `gws-default-config`가 우선 선택될 수 있습니다.');
    expect(skill).toContain('GWS_PROFILE=personal gws auth status');
    expect(skill).toContain('GWS_PROFILE=personal gws gmail +send');
  });

  it('reserves unqualified gws commands for explicitly shared account requests', () => {
    expect(skill).toContain('회사 공용·프로젝트 공용 계정을 명시한 경우에만 프로필 없이 `gws ...`');
  });

  it('uses the Gmail attachment helper instead of embedding MIME payloads in argv', () => {
    expect(skill).toContain('gws gmail +send');
    expect(skill).toContain('-a ./report.pdf');
    expect(skill).toContain('--draft');
    expect(skill).toContain('Linux `ARG_MAX`');
    expect(skill).toContain('Gmail message ID');
    expect(skill).not.toContain('BASE64_ENCODED_EMAIL');
  });

  it('pins the gws CLI baseline with Gmail attachment and draft support', () => {
    expect(runtimeBoxDockerfile).toContain('ARG GWS_CLI_VERSION=0.22.5');
    expect(skill).toContain('Tower baseline인 0.22.5 이상');
  });
});
