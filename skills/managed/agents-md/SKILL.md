---
name: agents-md
description: >
  Generate or evolve AGENTS.md for any project.
  Default: workspace mode (non-dev teams, research, consulting, etc.).
  Auto-switches to code mode when strong code signals detected.
  Use when setting up a project, refreshing stale context, or deepening project understanding.
context: fork
agent: general-purpose
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
argument-hint: "[path] [--code] [--evolve]"
---

# agents-md

Generate or evolve an AGENTS.md — the project's living brain.

**Default is workspace mode** — non-developer teams, research, consulting, content projects.
Code mode activates automatically when code signals are strong, or with `--code` flag.

## Usage

```
/agents-md                        # Workspace mode (default) for current project
/agents-md /path/to/project       # For a specific project
/agents-md --code                 # Force code mode
/agents-md --evolve               # Evolutionary update (read existing, apply delta)
```

---

## Mode Detection

Auto-detect on entry. **Workspace is default.** Switch to code mode only when evidence is strong.

| Signal | Count needed | Mode |
|--------|-------------|------|
| `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml` (with src/) | 1+ | **Code** |
| `.github/workflows/`, `Makefile`, `Dockerfile` | 2+ | **Code** |
| Markdown files, PDFs, research docs, proposals | any | **Workspace** (default) |
| `sources/`, `work/`, `final/`, `records/`, `decisions/`, `knowledge/`, `.project/` | any | **Workspace** |

When in doubt, default to workspace. A consulting project with a few Python scripts is still workspace mode.

---

## The Core Test (Both Modes)

Before including ANY line in AGENTS.md, it must pass this gate:

> **"If a fresh agent starts a new session in this project with no AGENTS.md,
> what would they get wrong or waste time on?"**
>
> If they'd figure it out → exclude. If they'd get it wrong → include.

### Workspace Mode Examples (pass)

- "이 고객은 비용 절감보다 안정성을 중시한다 — 제안서 톤을 맞춰라"
- "응답은 한국어, 단 기술 용어는 영문 병기"
- "deliverables/final/ 안의 파일만 고객에게 전달된다. draft/ 는 내부용"
- "Claims-First: 청구항을 먼저 완벽하게 → 나머지는 그 위에 번역"

### Workspace Mode Examples (fail — exclude)

- "이 프로젝트는 제안서 작성 프로젝트이다" → 파일 보면 안다
- "research/ 폴더에 리서치 문서가 있다" → 이름이 말해준다
- 폴더 트리 전체 나열 → `ls`하면 된다

### Code Mode Examples (pass)

- "sync-exclude must be a YAML inline array `[codex]`, NOT a boolean"
- "`make build` silently produces unversioned binaries if `git` is not on PATH"
- "PRs to `main` require a Linear issue link in the branch name"

---

## Protocol: Workspace Mode (Default)

### Phase 0: ORIENT

1. **Detect target**: `$ARGUMENTS` or cwd
2. **Mode check**: Scan for code signals. If insufficient → workspace mode (this protocol)
3. **Check existing AGENTS.md**: 
   - Exists and substantive (>5 lines, not default template)? → **Evolve mode**: read it, preserve good parts
   - Exists but default template ("Project context goes here")? → **Fresh mode**: replace
   - Missing? → **Fresh mode**: create
4. **Seed visible scaffold if missing**:
   ```bash
   mkdir -p records decisions knowledge
   ```
   - Create `records/work-log.md` if absent (people-visible work log)
   - Create `decisions/.template.md` if absent (visible project decisions)
   - Do **not** create `.project/` for new projects. If a brownfield project already has `.project/`, treat it as legacy compatibility input only.
5. **Scan sources** — gather all available signal:

| Source | What to Extract |
|--------|----------------|
| **Existing AGENTS.md** | Current understanding (preserve if evolving) |
| **`records/work-log.md`** | People-visible work history — patterns, learnings, direction changes |
| **`.project/progress.md`** | Legacy compatibility work history if the folder already exists |
| **`decisions/`** | Visible project decisions with rationale |
| **`.project/decisions/`** | Legacy compatibility decision records if the folder already exists |
| **`knowledge/INDEX.md`, `knowledge/`** | Reusable patterns, runbooks, research, briefs |
| **All files in project** | Types of artifacts, structure, naming patterns |
| **README, docs, plans** | Stated goals, scope, methodology |
| **File modification dates** | What's actively being worked on vs stale |

6. **Present plan**:

```
## AGENTS.md Plan

**Project**: [name] ([path])
**Mode**: Workspace
**Action**: [Fresh / Evolve (delta from last update)]

**Sources found**:
- records/work-log.md: [N entries]
- .project/progress.md: [N entries, if legacy folder exists]
- decisions/: [N records]
- .project/decisions/: [N records, if legacy folder exists]
- knowledge/: [summary]
- Files: [summary of what exists]

**Sections to generate**:
- Purpose & Scope
- Context & Constraints
- Work Conventions
- Key Decisions
- Current State

Proceed?
```

Wait for confirmation.

---

### Phase 1: ANALYZE

Extract non-discoverable knowledge from workspace sources.

#### 1.1 Purpose & Scope Probes

- What is this project trying to produce? (proposals, research, code, content?)
- Who is the audience? (client, internal, public?)
- Is there a deadline or milestone?
- What are the boundaries — what is NOT in scope?

Sources: README, existing AGENTS.md, file names, records/work-log.md entries, and legacy .project/progress.md entries if present

#### 1.2 Context & Constraints Probes

- Domain-specific knowledge that shapes all work (industry, regulations, client preferences)
- Language/tone/format requirements
- Referenced external materials or prior projects
- Team composition — who works on this, what roles?

Sources: records/work-log.md patterns, decisions/, knowledge/, legacy .project inputs if present, file content samples

#### 1.3 Work Convention Probes

- Output format conventions (file types, naming, folder organization)
- Quality standards (what "done" means here)
- Tools or services used (specific APIs, data sources)
- Recurring patterns in records/work-log.md (things done repeatedly)

Sources: file structure, records/work-log.md, legacy .project/progress.md if present, actual artifacts

#### 1.4 Key Decision Probes

- Decisions that constrain future work
- Trade-offs that were made and why
- Things that were tried and abandoned (anti-patterns)

Sources: `decisions/`, records/work-log.md, and legacy `.project/decisions/` / `.project/progress.md` entries if present

#### 1.5 Current State Probes

- What's actively being worked on?
- What's completed vs in-progress vs planned?
- Blockers or open questions?

Sources: recent file modifications, records/work-log.md latest entries, and legacy .project/progress.md if present

#### 1.6 Non-Discoverability Review (Self-Audit)

For EACH item collected, ask:
> "Would a fresh agent figure this out from reading the files?"

- Yes → **remove**
- Eventually, but would waste time → **keep, mark as time-saver**
- Would get it wrong → **keep, mark as critical**

Report: `{critical: N, time-saver: N, removed: N}`

---

### Phase 2: WRITE

#### Fresh Mode

Generate `AGENTS.md` with this structure. Empty sections are omitted — **except Document Convention, which is always included.**

```markdown
# [Project Name]

[1-2 sentence description of what this project is and what it produces]

## Context

[Domain knowledge, client/audience info, constraints that shape all work.
Only things an agent wouldn't know from reading the files.]

## Conventions

[Language, tone, format, output structure, naming.
Only conventions that aren't obvious from existing artifacts.]

## Document Convention

이 프로젝트의 기록은 visible scaffold를 우선 따른다:

- **원본**: `sources/` — 업로드, raw data, 캡처, 대본.
- **작업 중**: `work/<artifact>/` — 초안, 분석, build/intermediate. 큰 작업 폴더에는 `MANIFEST.md`를 둔다.
- **최종본**: `final/<artifact>/` — 공유 가능한 산출물과 전달 패키지. 큰 산출물 폴더에는 `MANIFEST.md`를 둔다.
- **작업 로그**: `records/work-log.md`에 append. 기존 프로젝트에 `.project/progress.md`가 있으면 참고만 한다.
- **프로젝트 결정**: `decisions/YYYY-MM-DD-제목.md` 우선. 기존 `.project/decisions/`는 참고용 legacy 경로.
- **재사용 지식**: `knowledge/` — patterns, runbooks, research, briefs.
- **팀 전체 결정**: 여러 프로젝트에 영향을 주는 결정은 `workspace/decisions/`에 기록.
- **이 파일 (AGENTS.md)**: 충분히 안정된 운영 규칙만 짧게 반영한다. `/agents-md --evolve`로 records/decisions/knowledge를 종합해서 갱신.

> 판단 기준: "이 결정이 다른 프로젝트에도 영향을 주는가?" → Yes면 workspace/decisions/, No면 decisions/

## Key Decisions

[Decisions that constrain future work. Link to decisions/ for rationale.
For brownfield projects, legacy .project/decisions/ can be referenced as historical input.
Only decisions an agent might accidentally violate.]

## Current State

[What's in progress, what's done, what's next.
Brief — this section evolves most frequently.]
```

#### Evolve Mode (`--evolve` or existing substantive AGENTS.md)

Do NOT rewrite from scratch. Instead:

1. **Read current AGENTS.md** — this is the baseline
2. **Identify delta** — what's new since last update?
   - New `records/work-log.md` entries
   - If a legacy `.project/progress.md` exists, read it as compatibility input only
   - If `progress-archive/` exists, **do NOT read it** — it's already been synthesized into earlier AGENTS.md versions
   - New files in `decisions/` and, for brownfield projects only, `.project/decisions/`
   - New or changed reusable material in `knowledge/`
   - New or removed files in project
3. **Apply changes**:
   - **Preserve**: sections that are still accurate
   - **Update**: sections with new information (add, don't replace unless wrong)
   - **Remove**: references to files/decisions that no longer exist
   - **Add**: new sections only if new non-discoverable knowledge emerged
4. **Log what changed** in the report. Do not create `.project/state.json` for new projects; update it only if a brownfield project already uses it.

**Critical rule**: When evolving, the existing AGENTS.md is treated as accumulated knowledge, not disposable text. Removal requires justification.

#### After writing

Do not create `CLAUDE.md` for new projects. `AGENTS.md` is the canonical instruction file.

If a brownfield project already has `.project/state.json`, update it best-effort for compatibility. Otherwise do not create `.project/`.

---

### Phase 3: REPORT

```markdown
## agents-md Complete

**Mode**: Workspace [Fresh / Evolve]
**Files**:
- `AGENTS.md` — [N lines, M sections]
- `records/work-log.md` — [created / already existed]
- `decisions/` — [created / already existed]
- `knowledge/` — [created / already existed / summarized]
- `.project/` — [legacy input if existed / not created]

**Coverage**:
- Critical: [N] (agent would get wrong without this)
- Time-savers: [N] (agent would waste time)
- Removed: [N] (discoverable from files)

**Staleness risk**:
- [Section] — [risk level] ([why])

**Refresh trigger**: Re-run `/agents-md --evolve` when:
- Significant work completed (5+ records/work-log.md entries since last update)
- Major direction change or new decision
- New reusable runbook/pattern enters `knowledge/`
- New team member joins the project
```

---

## Protocol: Code Mode

Activated by `--code` flag or when strong code signals detected (package.json + src/, CI, Dockerfile, etc.)

### The Non-Discoverability Test (Code)

> "Can an agent discover this by reading the code, running --help, or following standard conventions?"

#### Anti-Pattern Table

| Tempting to include | Why it FAILS | Write instead |
|--------------------|--------------|----|
| "This is a Python project" | `ls` reveals it | Nothing |
| Directory tree | `find .` reveals it | Only files with non-obvious PURPOSE |
| "Run `npm install`" | Standard convention | Only if setup has gotchas |
| Function signatures | Code reveals them | Implicit contracts not in types |

### Phase 0: PLAN (Code)

1. Detect target, check existing AGENTS.md (same as workspace)
2. **Scan for code signals**:

| Category | Where to Look |
|----------|---------------|
| Build/test | `package.json`, `Makefile`, `Cargo.toml`, CI configs |
| Git hooks | `.husky/`, `.git/hooks/`, `lefthook.yml` |
| Environment | `.env.example`, `.tool-versions`, `.nvmrc`, Dockerfiles |
| Deployment/CI | `.github/workflows/`, `Jenkinsfile`, `vercel.json` |
| Conventions | `CONTRIBUTING.md`, linter configs |

3. Present plan, wait for confirmation

### Phase 1: ANALYZE (Code)

#### 1.1 Workflow Command Probes
- Exact commands with required flags
- What goes wrong if you omit a flag (failure mode)
- Skip if `--help` is sufficient

#### 1.2 Gotcha Probes

| Type | How to Find |
|------|------------|
| Format gotchas | Validation code, regex patterns |
| Ordering/precedence | Priority logic, fallback chains |
| Environment variables | `process.env`, `os.environ` — silent behavior changes |
| Silent failures | `catch` blocks that swallow, `|| true` patterns |
| State dependencies | Services, symlinks, installed tools that must exist |
| Timing/ordering | Must X happen before Y? |

#### 1.3 Key File Probes
- WHY the file matters (not what it is)
- What BREAKS if modified incorrectly

#### 1.4 Convention Probes
- Not enforced by tooling, counter to defaults, implicit

#### 1.5 Self-Audit
Same as workspace: apply non-discoverability filter, classify {critical, time-saver, removed}

### Phase 2: WRITE (Code)

```markdown
# AGENTS.md — [repo-name]

Operational knowledge that agents cannot discover from reading the code.

## Workflow
[Commands with flags and failure modes. Only non-obvious.]

## Gotchas
[Grouped by severity. What + what it looks like + how to fix.]

## Key Files
[Table: File | Why It Matters. Only where WHY is non-obvious.]

## Conventions
[Only conventions not enforced by tooling.]

## Document Convention

이 프로젝트의 기록은 visible scaffold를 우선 따른다:

- **원본**: `sources/`
- **작업 중**: `work/<artifact>/`
- **최종본**: `final/<artifact>/`
- **작업 로그**: `records/work-log.md`
- **프로젝트 결정**: `decisions/` 우선. 기존 `.project/decisions/`는 brownfield 참고용 legacy 경로
- **재사용 지식**: `knowledge/`
- **팀 전체 결정**: 여러 프로젝트에 영향 → `workspace/decisions/`에 기록.
- **이 파일 (AGENTS.md)**: 직접 수정하지 않는다. `/agents-md --evolve`로 갱신.
```

Do not create `CLAUDE.md` or `.project/` for new projects. `AGENTS.md` plus the visible scaffold is the default.

### Phase 3: REPORT (Code)
Same structure as workspace report.

---

## Legacy `.project/` Directory

Do not create `.project/` for new projects. Some brownfield projects still have it from the previous scaffold; read it as compatibility input only.

```text
.project/
├── progress.md          # Legacy work log
├── progress-archive/    # Legacy archived work log
├── decisions/           # Legacy decision records
└── state.json           # Legacy agents-md metadata
```

Current defaults:

| Purpose | New default | Legacy input if present |
|---|---|---|
| Work log | `records/work-log.md` | `.project/progress.md` |
| Project decisions | `decisions/` | `.project/decisions/` |
| Reusable knowledge | `knowledge/` | n/a |
| agents-md change state | report summary | `.project/state.json` |

If a legacy `.project/progress.md` is huge, mention that it may need distillation, but do not create or migrate `.project/` automatically.

---

## Testing

### Test Pack

| Type | Scenario | Mode | Purpose |
|------|----------|------|---------|
| Primary | Workspace project with progress.md, decisions/, mixed files | Workspace | Core value: project context extraction |
| Evolve | Existing AGENTS.md + new progress entries | Workspace --evolve | Delta update without regression |
| Code | Repo with hooks, CI, sync scripts | Code (auto) | Code mode extraction |
| Edge | Empty project (just created, default AGENTS.md) | Workspace | Graceful first-run with minimal signal |
| Mode detect | Project with a few .py scripts but mostly docs | Workspace (auto) | Correct mode detection |

### Success Criteria

- **Workspace**: Captures project purpose, constraints, conventions that a fresh agent would miss
- **Evolve**: Existing knowledge preserved, delta applied, no regression
- **Code**: <10% discoverable contamination, catches gotchas, includes failure modes
- **Mode detection**: Correctly identifies workspace vs code in 95%+ of cases
