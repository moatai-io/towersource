import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const root = path.resolve(import.meta.dirname, '../../../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const skill = read('skills/system/commit-session/SKILL.md');
const entry = read('skills/commit-session/SKILL.md');
const guide = read('docs/tower-guide/resources/git.md');
describe('Evidence-reviewed session commit fallback contract', () => {
  it('allows missing-ledger edits with real evidence, not temporal observation alone', () => {
    expect(skill).toContain('기록 없음과 근거 없음은 다르다');
    expect(skill).toContain('실제 수정 호출과 현재 diff를 대조');
    expect(skill).toContain('같은 시간대의 변경 관찰만으로는 부족');
    expect(entry).toContain('직접 Git 절차');
    expect(guide).toContain('검토된 직접 Git을 허용');
  });
  it('keeps staged content, secrets and mixed ownership checks on both paths', () => {
    for (const text of ['git diff --cached --name-only', 'git diff --cached --check', 'git diff --cached`', 'git add -- <paths...>', 'Tower-Session: $TOWER_SESSION_ID', '혼합 변경', 'DB dump', 'Hook은 우회하지']) expect(skill).toContain(text);
    expect(skill).toContain('직접 Git에서도 중단 사유');
    expect(skill).toContain('기록 조작용 DB 삽입');
  });
  it('requires renewed review of changed approval and avoids incomplete commits', () => {
    expect(skill).toContain('동일한 파일·내용·메시지에 승인받았다면 반복 승인하지 않는다');
    expect(skill).toContain('다른 변경이 추가되면 다시 검토하고 승인');
    expect(skill).toContain('불완전한 커밋을 만들지 않는다');
    expect(skill).toContain('실패 시 무엇이 staged 상태로 남았는지');
  });
});

describe('Delegated work acceptance contract', () => {
  it('accepts reviewed delegated changes and same-task integration, not ancestry alone', () => {
    for (const text of ['명시적으로 위임하고 부모가 검증해 수용한 서브에이전트 수정', '세션 관계만으로 자식의 모든 변경을 포함하지 않는다', '완료 보고나 파일 목록만으로 수용하지 않는다', '작성 세션이 다르다는 이유만으로 혼합 변경으로 보지 않는다', '파일 전체 diff가 승인할 작업에 속하고']) expect(skill).toContain(text);
    expect(entry).toContain('수용한 서브에이전트 수정도 포함');
    expect(guide).toContain('현재 Session이 책임지는 작업 저장');
  });
  it('preserves autonomy while requiring settled writes and renewed verification', () => {
    for (const text of ['구현과 필요한 수정·검증을 재승인 없이', '부모도 수용 전 연동·회귀 문제를 고칠 수 있다', '쓰기 중단이 확인된 뒤', '수용 후 파일이 바뀌면 재검증', '무관한 작업의 실제 혼합 변경', '에이전트 생성이나 개별 작업자의 커밋을 자동 승인하지 않는다']) expect(skill).toContain(text);
  });
  it('uses direct review for missing child candidates without weakening script ownership', () => {
    expect(skill).toContain('자식 세션을 자동 수집하지 않는다');
    expect(skill).toContain('선택 B로 전체 작업 범위를 검토');
    expect(skill).toContain('세션 ID 대체나 기록 조작으로 후보를 늘리지 않는다');
    const scenarios = read('skills/system/commit-session/evals.md');
    expect(scenarios).toContain('실제 다중 에이전트 실행 검증을 구분');
    expect(scenarios).toContain('완료 보고만으로 stage');
  });
});
