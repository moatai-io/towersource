# git 모듈 — 구조 결정

## 왜 3 파일이 한 폴더에 묶였나

git *작업* (git-manager), git *격리 트리* (worktree-manager), AI *커밋 메시지 생성* (auto-commit-message) — 셋 다 git 도메인. 한 폴더로 묶으면 AI 가 "git 관련" 작업 받았을 때 grep 1번.

## 왜 worktree 가 default 가 아닌가

워크스페이스에 단일 git tree 유지 = 사용자 직관 (파일 탐색기 / VSCode 가 보는 그대로). worktree 격리는 "진짜 충돌 안 되는" 옵션이지만:
- 새 worktree마다 cwd가 달라져 사용자와 공용 dev server가 실제 변경을 보기 어렵다.
- 오래된 worktree가 장기 생존하면 과거 patch가 늦게 통합될 수 있다.
- Tower의 실제 작업 단위는 Session별 파일이 아니라 여러 Session이 함께 만든 통합 dev 상태다.

따라서 자동 worktree 생성을 금지하고, 다른 Session이 쓰지 않는 안전 지점에 `/checkpoint`로 전체 dirty 상태를 검토·검증해 commit한다. Worktree는 사용자가 명시적으로 요청한 예외에만 허용한다.

근거: `workspace/decisions/2026-08-28-shared-development-checkpoint-and-pr-workflow.md`
근거: `workspace/decisions/2026-05-03-multi-session-safety.md`

## 왜 auto-commit-message 가 engines/ 추상화를 안 거치나

이 함수는 generic utility (메시지 → 텍스트 한 줄). 호출 빈도 적음 (세션 종료 시 1회). engines/ 의 무거운 추상화 (TowerMessage 변환, callback, abort 신호) 가 필요 없음. SDK 직접 호출 = 코드 짧고 명확. 만약 Pi 엔진에서도 쓸 일이 생기면 그때 추상화 검토.

## 왜 git-manager 가 모놀리식 9KB 한 파일인가

git status/diff/log/commit/rollback — 같은 git CLI 호출 패턴 공유. 분리하면 execFile wrapper 가 5번 반복. 한 파일 안에서 helper (runGit) 한 번 정의 + 모든 함수가 사용. **deep module + 명시적 중복 회피.**

## 왜 message-store 가 import 됐나 (auto-commit-message 에서)

커밋 메시지를 짜려면 *이 세션이 뭘 했는지* 알아야 함. 가장 쉬운 source = 세션의 메시지 로그. AI 한테 "이 메시지들 보고 한 줄로 요약해" 시킴. diff 보다 의미 풍부 (사용자 의도 + AI 응답 모두).
