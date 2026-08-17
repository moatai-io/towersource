---
name: materialize-managed-skills
description: Tower dev/operator helper for applying the curated teamskills/default skill set into Project Runtime Box `.tower/skills` folders. Use when deploying organization skills to self-hosted servers, running "materialize skills", or verifying project-mounted skill manifests.
argument-hint: "[--all-projects | --project <id-or-name> | --project-root <path>]"
---

# materialize-managed-skills

Tower dev/operator-only helper. This skill documents the supported, repeatable path for materializing the curated teamskills/default skill set into project-local Runtime Box skill folders.

Boundary: this skill owns only generated `.tower/skills/` runtime copies. Project-owned local skill gardens live separately in `SKILL_GARDEN.md`, `skills/`, and `skill-lab/`; do not prune or overwrite them from the materializer. See `~/workspace/decisions/2026-06-10-project-local-skill-garden-materialization.md` and `~/workspace/decisions/2026-06-26-skills-external-repo-and-no-managed-seed.md`.

## When to use

Use this when the operator says:

- "materialize skills"
- "자체 호스팅 서버 전체 프로젝트에 스킬 배포"
- "Project Runtime Box teamskills 깔아"
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

`RUNTIME_BOX_MATERIALIZE_SKILLS=true` is the automatic materialization gate for Runtime Box startup; the CLI can still be run manually after deploy to backfill every project immediately.

## Success criteria

For the current customer default set:

- `summary.fail` is `0`
- `summary.skillCount` matches `teamskills/skillset.json` defaultSkills length
- `skipped` is empty for all projects
- every project has `/workspace/.tower/skills/manifest.json` in Runtime Box / `<project>/.tower/skills/manifest.json` on host
- `offer-A4-html` is **not** included in customer defaults

## Common errors and deployment tips

### Deploy may look stalled during Runtime Box image build

`ensure-runtime-box-image.sh` can spend a while in Docker build output. If the chat/tool stream is interrupted, do **not** rerun the whole deploy blindly. First inspect the remote state:

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
