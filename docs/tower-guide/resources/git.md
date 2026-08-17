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
- `git add -A` / `git add .` 보다 specific path. .env / 비밀파일 / 큰 binary 위험.
- **`git stash`와 새 worktree 생성 금지** (Tower multi-session 개발). stash는 다른 세션의 dirty 변경을 보이지 않게 만들고, 별도 worktree/branch는 통합되지 않은 코드를 누적시켜 실제 Dev root와 검증 소스를 갈라놓는다. 모든 Tower 개발은 루트 working tree의 현재 `main`에서 수행하고, 자기 변경은 specific path만 stage해 `/commit-session` 또는 명시적 commit으로 보관한다. unrelated dirty 파일은 그대로 두며, 격리가 필요하다는 이유로 `git worktree add`를 실행하지 않는다. 근거: `workspace/decisions/2026-05-26-no-stash-in-multi-session.md`, 루트 `AGENTS.md`의 Tower 개발 single-tree 정책.

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
- **자기 변경만 commit** 하려면 `/commit-session` 스킬 사용 (multi-session 환경에서 다른 세션의 dirty 파일 안 건드림). single-session 확신할 때만 직접 `git add` / `git commit`.
- **PR 만들기**: `/finish-branch` 스킬 또는 사용자 명시 요청 시 `gh pr create --title ... --body "$(cat <<'EOF' ... EOF
)"`.
- **push 후 self-host deploy 자동 실행 금지** — 사용자가 명시 요청 시만 (`/self-host deploy <customer>`). git push 의 자연스런 다음 단계가 *아닙니다*. 근거: workspace/decisions/2026-05-05-fleet-deploy-explicit-only.md.
