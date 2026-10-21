# Tower Git / PR Guide Resource

This resource is loaded on demand by Pi via `guide_read` when exact Tower git, commit, PR, and audit-trailer procedures are needed. Keep the system prompt short; keep multi-session destructive safety invariants in core.

## Git / PR — Tower 컨벤션

Tower 는 Claude Code 의 기본 git 템플릿을 끄고 (`includeGitInstructions: false`) 우리 컨벤션으로 대체합니다. 박혀있는 일반 git 지식을 무시하고 아래 규칙을 따르세요.

### 기본 원칙 (안전)
- 사용자가 *명시적으로* 요청할 때만 commit / push / PR 만들기. 빈 commit 만들지 말 것.
- Hook 우회 금지 (`--no-verify`, `--no-gpg-sign` 등). pre-commit hook 실패 시 원인 고치고 새 commit (amend 아님).
- amend 보다 새 commit. 특히 hook 실패 후 amend 금지 — 직전 commit 을 망가뜨릴 수 있음.
- force push 금지. main / master 로의 force push 는 사용자가 명시 요청해도 한 번 경고.
- `git config` 변경 금지. credential 이나 user.name / user.email 절대 안 만짐.
- 공유 개발 상태 전체를 정리할 때는 `/checkpoint`의 blocked-path 검사와 fingerprint 검증으로 전체 통합 commit을 만든다. 현재 Session이나 특정 hotfix만 저장할 때는 대화·수정 호출·현재 diff를 검토하는 `/commit-session`으로 확인된 경로만 specific add한다.
- **`git stash`와 새 worktree 생성 금지** (Tower multi-session 개발). stash는 다른 세션의 dirty 변경을 숨기고, 별도 worktree/branch는 통합되지 않은 과거 코드를 누적시킨다. 모든 Tower 개발은 루트 working tree의 현재 `main`에서 수행한다. 전체 정리는 `/checkpoint`, 독립 작업 저장은 `/commit-session`을 사용한다. 근거: `workspace/decisions/2026-08-28-shared-development-checkpoint-and-pr-workflow.md`.

### 메시지
- 한국어 OK. `feat(scope):`, `fix(scope):`, `docs(scope):` 등 conventional prefix 권장 (필수는 아님).
- multi-line 메시지는 **single-quoted HEREDOC body + 별도 `-m` trailer** 패턴 사용. 한 `-m` 안에 trailer 까지 같이 박으면 `'EOF'` 의 인용이 `$TOWER_SESSION_ID` 확장도 막아서 literal 로 박힘 (audit 깨짐):

```bash
git commit -m "$(cat <<'EOF'
feat(scope): subject 한 줄

body 여러 줄. single-quoted EOF 라 본문에 $literal_dollar 가 있어도 안전.
EOF
)" -m "Tower-Session: $TOWER_SESSION_ID"
```

- 위 패턴의 두 번째 `-m` 은 일반 쉘 인용이라 `$TOWER_SESSION_ID` 가 정상 확장됨. **이 trailer 한 줄은 AI 가 만든 모든 commit 에 필수** — `git log --grep "Tower-Session: <id>"` 로 세션별 추적이 audit 의 핵심.
- "Co-Authored-By: Claude" 같은 CC 기본 attribution 박지 말 것 — `Tower-Session:` trailer 가 audit 역할 대신함 (`settings.attribution: { commit: '' }` 으로 자동 차단됨, 우리가 수동으로 박을 일도 없음).

### 워크플로 — 스킬 우선
- **전체 공유 상태 저장**은 `/checkpoint`를 사용한다. 전체 dirty 목록 확인, 쓰기 동결, 검증 fingerprint 일치 후 통합 commit한다.
- **현재 Session이 책임지는 작업 저장**은 `/commit-session`을 사용한다. AI가 대화·수정 호출·현재 diff로 확인한 dirty 파일만 specific add하고, 명시적으로 위임하고 부모가 검증해 수용한 서브에이전트 수정도 포함하되 무관한 Session 변경은 그대로 둔다. 같은 작업의 후속·통합 수정은 작성 세션이 다르다는 이유만으로 혼합으로 보지 않는다. Ledger와 스크립트는 보조 수단이며 기록 누락 시 검토된 직접 Git을 허용한다. 혼합 변경, 예상 밖 staged 파일, 검증 실패는 어느 경로에서도 중단한다.
- Push는 `scripts/git/push-main-safe`로 승인된 committed SHA만 `origin/main`에 보낸다. dirty working tree는 Push snapshot에 포함되지 않는다.
- **PR 만들기**: `/finish-branch` 스킬 또는 사용자 명시 요청 시 `gh pr create --title ... --body "$(cat <<'EOF' ... EOF
)"`.
- **push 후 실행 중인 self-host 자동 변경 금지** — 배포는 사용자가 명시 요청하고 운영자가 승인한 별도 절차로 수행합니다. git push의 자연스러운 다음 단계가 아닙니다.

세부 수용 기준은 [세션 커밋 정본](../../../skills/system/commit-session/SKILL.md)을 따른다. 스크립트는 현재 세션 기록만 조회하므로 위임 변경 누락 시 직접 Git 경로에서 전체 작업을 검토한다. [계약 회귀 테스트](../../../packages/backend/services/git/session-commit-fallback.source.test.ts)와 [협업 검토 시나리오](../../../skills/system/commit-session/evals.md)는 규칙 보존과 판단 점검용이며, 실제 다중 에이전트 커밋의 운영 검증을 대신하지 않는다.
