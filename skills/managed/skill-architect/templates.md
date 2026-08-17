# Skill Templates

Ready-to-use templates for different skill types. Copy and customize.

## Available Templates

| Template | Use When | File |
|----------|----------|------|
| **Reference** | Background knowledge, conventions, guidelines | [templates/reference.md](templates/reference.md) |
| **Task** | Step-by-step instructions for specific actions | [templates/task.md](templates/task.md) |
| **File-Writing** | Tasks that create or modify files | [templates/file-writing.md](templates/file-writing.md) |
| **Multi-Agent** | Orchestrating multiple agents or CLIs | [templates/multi-agent.md](templates/multi-agent.md) |
| **Minimal** | Absolute minimum for a working skill | [templates/minimal.md](templates/minimal.md) |
| **Python Script** | scripts/*.py 안에 들어갈 Python 스크립트 (PEP 723 표준) | [templates/python-script.md](templates/python-script.md) |

---

## Template Selection Guide

| If your skill... | Use Template |
|------------------|--------------|
| Provides conventions/knowledge | Reference |
| Executes a specific task | Task |
| Creates or modifies files | File-Writing |
| Coordinates multiple agents/CLIs | Multi-Agent |
| Is extremely simple | Minimal |

**Hybrid Approaches:**
- Reference + Task: Add `disable-model-invocation: true` to reference skills that should only run when explicitly invoked
- Task + File-Writing: All file-writing skills are tasks, but not all tasks write files
- Multi-Agent + File-Writing: Most multi-agent skills write consolidated output files

---

## Python Scripts in `scripts/` — PEP 723 + uv run --script (필수)

스킬에 Python `scripts/` 가 들어가면 모든 스크립트는 PEP 723 inline metadata 헤더를 박고 `uv run --script` 로 호출한다. 시스템 python 의존 금지. 격리 venv 안에서만 deps 사용.

상세: [`cookbook/create.md`](cookbook/create.md) §2.5.1
근거: `workspace/decisions/2026-05-08-skill-uv-pep723-standard.md`

---

## Runtime Portability

범용 스킬 템플릿에는 Tower-specific 실행 구조를 직접 박지 않는다. `mcp__sandbox__run`, `sandbox.tool.start`, publishing symlink 같은 세부사항은 현재 runtime/system prompt/tool guard 가 주입한다.

권장 문구:

```md
실행이 필요하면 현재 환경이 승인한 실행 경로를 사용한다.
정적 산출물은 현재 환경의 publishing 규칙에 맞춰 배치한다.
```

예외: `fleet`, `library`, `selfheal` 같은 Tower 운영 전용 스킬.

상세: [`cookbook/create.md`](cookbook/create.md) §2.5.2
근거: `workspace/decisions/2026-05-26-skill-portability-and-runtime-execution-contract.md`

---

## Testing Guidance

- All skill types benefit from at least a Primary JTBD
- File-writing and Multi-agent skills should include Edge cases
- Add Regression tests when fixing bugs in existing skills

**CDM/RPD Guidance:**
- Add **RPD Card** when skill involves a critical decision with multiple patterns
- Add **Classification Gym** (3-6 scenarios) for skills where pattern discrimination matters
- Add **Decision Requirement Table** to map expert vs novice cue recognition
- RPD Cards are **mandatory** for skills where wrong decisions have significant consequences
