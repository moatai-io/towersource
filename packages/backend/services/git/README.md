# services/git — Git 작업 / 워크트리 / 자동 커밋 메시지

워크스페이스의 git 저장소 작업 (status, diff, log, commit, rollback), 멀티세션 격리용 worktree 관리, AI 가 자동 작성하는 commit 메시지 생성을 담당.

## 책임

- **Git CRUD** — status, diff, log, manual commit, rollback (git-manager)
- **자동 커밋** — 세션 종료 시 또는 변경 누적 시 자동 commit (git-manager.autoCommit)
- **워크트리 관리** — 세션별 격리 git worktree 생성/삭제 (worktree-manager)
- **AI 커밋 메시지** — 변경 내용 + 메시지 로그 → 자연스러운 한 줄 메시지 (auto-commit-message)

## Public API

### `git-manager.ts` — workspace 저장소 작업
- `getLog(filePath?, limit?)` — git log
- `getFileDiff(filePath, ref?)` — git diff
- `manualCommit(message, paths?)` — 사용자 트리거 commit
- `rollbackToCommit(sha)` — 특정 commit 으로 복원
- `autoCommit(reason, paths?)` — 자동 commit (세션 종료 등)
- `initWorkspaceRepo()` — 부팅 시 workspace 가 git repo 인지 확인 / init

### `worktree-manager.ts` — 격리 worktree
- `createWorktree(sessionId, baseBranch?)` — 세션 ID 로 격리 트리 생성
- `removeWorktree(sessionId)` — 정리
- 멀티 세션이 같은 main tree 의 dirty state 를 섞지 않도록 함
- 근거: workspace/decisions/2026-05-03-multi-session-safety.md

### `auto-commit-message.ts` — AI 자동 commit 메시지
- `generateAutoCommitMessage(sessionId)` — 세션 메시지 + diff → 커밋 메시지 한 줄
- 내부: SDK quickReply 호출 (engine 추상화 안 거침 — 직접 SDK)

## 들어오기 전에 알아야 할 것

- **워크스페이스 = 단일 git repo** (이 서버 기준). 즉 multi-user / multi-session 모두 같은 working tree 공유. 충돌 방지 패턴 = worktree 격리 또는 specific-paths commit.
- **autoCommit 은 멱등** — 변경 없으면 commit 안 만듦. 안전하게 여러번 호출 가능.
- **manualCommit / autoCommit 모두 specific paths 사용** — `git add .` 절대 금지 (다른 세션 변경 섞임).
- **worktree 는 옵션** — 본 서버는 default 단일 tree 사용. specific paths commit 으로 충돌 회피.
- **auto-commit-message 는 SDK 직접 호출** — engines/ 거치지 않음. 가벼운 utility 라 격리 단순화.
- **rollbackToCommit 은 hard reset** — 사용자 명시 확인 필수.

## 관련 결정문서

- `workspace/decisions/2026-05-03-multi-session-safety.md` — multi-session 안전 / worktree 정책
- `workspace/decisions/2026-05-03-ai-friendly-refactoring.md` — 이 폴더가 분리된 이유

## 관련 모듈

- `services/message-store` — auto-commit-message 가 메시지 fetch 해서 메시지 만듦
- `services/task/task-runner` — task 시작 시 worktree 생성 (격리 실행)
- `engines/claude-engine` — 세션 종료 시 autoCommit 트리거 + auto-commit-message 호출
- `routes/api.ts` — git CRUD REST 엔드포인트
- `index.ts` — 부팅 시 initWorkspaceRepo

## 테스트

- 단위 테스트 없음 (git CLI / fs 의존성 큼). ws-handler.test.ts 가 git-manager 를 vi.mock 으로 stub.
