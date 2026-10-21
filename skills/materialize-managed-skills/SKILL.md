---
name: materialize-managed-skills
description: Tower dev/operator helper for applying the curated teamskills/default skill set into Project-visible `.tower/skills` folders. Use when deploying organization skills to self-hosted servers, running "materialize skills", or verifying project-mounted skill manifests.
version: 0.1.1
argument-hint: "[--all-projects | --project <id-or-name> | --project-root <path>]"
---

# materialize-managed-skills

Tower dev/operator-only helper. This skill documents the supported, repeatable path for materializing the curated teamskills/default skill set into Project-visible `.tower/skills` folders. The Project workspace is the authority; Runtime Box is only a legacy compatibility consumer where still present.

Boundary: this skill owns only generated `.tower/skills/` runtime copies. Project-owned local skill gardens live separately in `SKILL_GARDEN.md`, `skills/`, and `skill-lab/`; do not prune or overwrite them from the materializer. See `~/workspace/decisions/2026-06-10-project-local-skill-garden-materialization.md` and `~/workspace/decisions/2026-06-26-skills-external-repo-and-no-managed-seed.md`.

## When to use

Use this when the operator says:

- "materialize skills"
- "자체 호스팅 서버 전체 프로젝트에 스킬 배포"
- "Project에 teamskills 깔아"
- "legacy Runtime Box의 project skill copy도 확인해"
- "demo-server / demo-org 에 기본 스킬셋 넣어"
- "`.tower/skills` manifest 검증"

## Canonical command

From the Tower repo root on the target VM:

```bash
npm run skills:materialize -- --all-projects
```

Machine-readable output:

```bash
npm run skills:materialize -- --all-projects --json
```

Single project:

```bash
npm run skills:materialize -- --project <id-or-name>
npm run skills:materialize -- --project-root /home/<user>/workspace/projects/<project>
```

## Teamskills vs local skill garden

Use this command for teamskills/default materialization: curated organization skills copied into `.tower/skills/manifest.json` and `.tower/skills/<skill>/`.

For optional project-local skill garden dogfooding, use the shared scaffold package instead:

```text
~/workspace/projects/shared/incoming/skill-garden-scaffold/
```

Recommended local modes are `hook-only`, `light`, and `full`. Keep that flow separate until manual dogfooding proves the final unified CLI shape.

## Expected default set

The default list comes from:

```text
~/workspace/projects/teamskills/skillset.json
```

`packages/backend/config.ts` / `DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS` is only a temporary compiled name-list fallback when teamskills is unavailable during bootstrap/tests. It is not a body source.

Do not hand-maintain a separate list unless intentionally overriding with:

```bash
RUNTIME_BOX_MATERIALIZED_SKILLS=<comma-separated-list>
```

`RUNTIME_BOX_MATERIALIZE_SKILLS`와 `RUNTIME_BOX_MATERIALIZED_SKILLS`는 남아 있는 compatibility 설정명이다. 현재 정본은 Project별 `.tower/skills` materialization이며, CLI는 배포 후 Project-visible copies를 backfill할 때 사용할 수 있다. Runtime Box startup 연동은 compatibility 경로에서만 의미가 있다.

## Success criteria

For the current customer default set:

- `summary.fail` is `0`
- `summary.skillCount` matches `teamskills/skillset.json` defaultSkills length
- `skipped` is empty for all projects
- every canonical Project has `<project>/.tower/skills/manifest.json`; legacy Runtime Box가 실제 consumer이면 그 안의 `/workspace/.tower/skills/manifest.json`도 같은 manifest를 노출
- `offer-A4-html` is **not** included in customer defaults

## Common errors and deployment tips

### Compatibility deploy may look stalled during Runtime Box image build

Runtime Box compatibility까지 포함한 배포에서는 `ensure-runtime-box-image.sh`가 Docker build output에 오래 머물 수 있다. canonical Project skill materialization 자체는 이 이미지에 의존하지 않는다. compatibility 배포 중 chat/tool stream이 끊겨도 전체 배포를 맹목적으로 다시 실행하지 말고 remote state를 먼저 확인한다.

```bash
ssh <target> 'cd ~/tower; git rev-parse --short HEAD; node -p "require(\"./package.json\").version"; pm2 status tower-prod; curl -sS http://localhost:32364/api/health'
```

If repo HEAD is updated but `/api/health` still reports the old version, continue only the remaining steps: image build if needed, `npm run build`, `pm2 restart tower-prod --update-env`.

### `npm run ... -- --json` is not pure JSON

`npm run` prints npm headers before the script output. For machine-readable checks, call the script directly:

```bash
npx tsx packages/backend/scripts/materialize-managed-skills.ts --all-projects --json
```

### JSON output must not include shutdown logs

The CLI suppresses PG pool close logs in `--json` mode. If JSON parsing reports `Extra data`, check for trailing operational logs after the closing `}` and fix the script rather than working around it in every deploy.

### Top-level await in `tsx -e`

Avoid ad-hoc `tsx -e` one-liners with top-level await. Use the CLI instead.

### Wrong DB import

Do not import `query` from `packages/backend/db/pg.ts`; use `packages/backend/db/pg-repo.ts`. The CLI already handles this.

### Missing skill

If a skill is skipped as `not_found_or_disallowed`, first check whether the target VM has the skill source under `~/workspace/projects/teamskills/skills/<skill>/` and the name in `teamskills/skillset.json` or the explicit `--skills` list. Do not expose host-global skill folders or `~/tower/skills/managed` to project sessions as a workaround.

## Demo-server rollout pattern

After code deploy/restart on demo-server:

```bash
cd ~/tower
npm run skills:materialize -- --all-projects --json
```

Then verify:

```bash
python3 - <<'PY'
import json, pathlib
base = pathlib.Path.home() / 'workspace/projects'
counts = []
bad = []
for mf in base.glob('*/.tower/skills/manifest.json'):
    data = json.loads(mf.read_text())
    names = [s['name'] for s in data.get('skills', [])]
    counts.append(len(names))
    if 'offer-A4-html' in names:
        bad.append((mf.parent.parent.parent.name, 'has-offer-A4-html'))
print('manifest_counts', sorted(set(counts)))
print('bad', bad)
PY
```
