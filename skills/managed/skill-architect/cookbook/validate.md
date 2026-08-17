# /skill-architect validate — 단일 스킬 검증 (+ 자동 fix)

스킬의 frontmatter / 구조 / best practice 를 체크하고, 자동 가능한 수정은 그 자리에서 적용. `/skill-architect create` 의 Phase 4 단계가 내부에서 호출하는 흐름이지만, **이미 등록된 스킬을 점검**하는 용도로 직접 호출도 가능.

## When this runs

- `/skill-architect validate <path>` 명시 호출 — 단일 스킬 검증
- `/skill-architect create` Phase 4 의 자동 호출 — 스캐폴드 직후 품질 게이트
- `/skill-architect refine` 의 마지막 단계 — distill 후 재검증

## Arguments

```
/skill-architect validate <path>          # 단일 스킬 (기본 — fix 제안만)
/skill-architect validate <path> --fix    # 자동 가능한 항목 즉시 수정
```

`<path>` 는 `skills/managed/<name>/`, `skills/<name>/`, `/workspace/.tower/skills/<name>/`, 또는 해당 `SKILL.md` 파일 모두 OK. Legacy `legacy provider config home/skills`는 migration/fallback 진단 때만 사용한다.

## Steps

### 1. SKILL.md 읽기 + frontmatter parse

YAML frontmatter 추출 → name, description, version, tags, allowed-tools, context, agent 등.

### 2. 검증 체크리스트 적용

체크리스트 본체는 현재 스킬 번들의 `validation.md` 참조. Project Runtime Box에서는 `/workspace/.tower/skills/skill-architect/validation.md` 기준이다. 카테고리별 요약:

| 카테고리 | 항목 | Severity |
|---|---|---|
| **Frontmatter** | name (소문자+하이픈, 예약어 X), description (≤1024자, XML 없음, 3인칭), version 형식, tags 유효 | ERROR |
| **Frontmatter** | description 에 "Use when ..." 트리거 명시 | WARN |
| **Structure** | SKILL.md ≤ 500줄, reference 파일 ≤ 1 level 깊이, 참조 파일 존재 | ERROR / WARN |
| **Structure** | TOC (≥100줄 reference 파일에) | INFO |
| **Best Practice** | file-writing 류는 execution plan 단계 있음 | WARN |
| **Best Practice** | 파일을 쓰는 스킬은 짧은 `Output path` 섹션으로 `/tmp`·특정 프로젝트 hard-code를 피하고 현재 프로젝트 AGENTS/scaffold 우선 원칙을 둠 | WARN |
| **Best Practice** | Tower-specific 실행 구조(`mcp__sandbox__run`, `sandbox.tool.start`, publishing symlink 등)를 portable 스킬 본문에 직접 박지 않음 | WARN |
| **Best Practice** | side-effect 스킬은 `disable-model-invocation` 명시 | INFO |
| **Best Practice** | MCP 도구는 `Server:tool_name` 정규형 | WARN |
| **Best Practice** | 스킬 이름이 동명사 형 (gerund) | INFO |
| **Best Practice** | description 이 대표 사용자 prompt 들로 트리거 테스트됨 | INFO |
| **Testing** | JTBD 시나리오 Test Pack 포함 | INFO |
| **Testing** | 성공 기준 명시 | INFO |
| **Python deps** | scripts/*.py 마다 PEP 723 헤더 (외부 deps 있을 때) | ERROR |
| **Python deps** | PEP 723 dependencies vs 실제 import 정합성 | WARN |
| **Python deps** | SKILL.md 호출이 `python3` 가 아닌 `uv run --script` | ERROR |

ERROR 1 개 이상 → FAIL. WARN 만 있으면 PASS-WITH-WARN. INFO 는 권고.

### 2.1 Python deps audit — 정합성 체크

`scripts/` 디렉토리에 `.py` 파일이 있으면 다음 3 단계로 정합성 검증:

**a. 외부 import 추출** — 각 .py 의 toplevel + 들여쓰기된 `from X import Y` / `import X` 를 모두 모은 후 stdlib 제외:

```bash
# 알려진 stdlib 모듈은 제외 (os, sys, json, re, time, pathlib, typing, argparse, ...)
grep -hE "^[[:space:]]*(from|import) " script.py | \
  sed -E 's/^[[:space:]]*(from|import) ([a-zA-Z_][a-zA-Z0-9_]*).*/\2/' | \
  sort -u
```

import 이름 → PyPI 패키지명 매핑 (자주 헷갈리는 것):
| import | PyPI 패키지 |
|---|---|
| `PIL` | `pillow` |
| `yaml` | `pyyaml` |
| `from google import genai` | `google-genai` |
| `pptx` | `python-pptx` |
| `cv2` | `opencv-python` |
| `bs4` | `beautifulsoup4` |
| `sklearn` | `scikit-learn` |

**b. PEP 723 헤더 파싱** — 첫 30줄 안에서 `# /// script` ~ `# ///` 블록 검출 + dependencies 리스트 추출:

```bash
awk '/^# \/\/\/ script$/,/^# \/\/\/$/' script.py | \
  grep -oP '"\K[^"\s]+' | sort -u
```

**c. 정합성 비교** — 두 집합 차이 보고:

| 케이스 | severity | 처리 |
|---|---|---|
| 외부 import 있는데 PEP 723 헤더 없음 | **ERROR** | 헤더 없이 호출 시 ModuleNotFoundError. `--fix` 로 자동 추가 (외부 import 만 deps 로) |
| import 에 있는데 PEP 723 deps 누락 | **ERROR** | 호출 시 ModuleNotFoundError. `--fix` 로 deps 추가 |
| PEP 723 deps 에 있는데 import 안 됨 | **WARN** | dead deps. 깔끔히 정리 권고 (`--fix` 로 제거) |

**d. SKILL.md 호출 패턴 검증**:

```bash
grep -nE "(^|[^#])python3?\s+\S+\.py" SKILL.md
```

매칭되면 → ERROR. `python3` 호출은 시스템 python 의존이라 격리 깨짐. `uv run --script <path>.py` 로 변경 (`--fix` 가능).

**예외**: 외부 deps 가 *없는* 스크립트 (pure stdlib) 는 `python3` 호출 OK — 시스템 python 으로 충분. 그 경우 PEP 723 헤더도 생략 가능.

근거: `workspace/decisions/2026-05-08-skill-uv-pep723-standard.md`

### 3. 자동 fix 가능한 항목 (--fix 시)

- frontmatter format (들여쓰기, key 순서, 빈 줄)
- description 의 XML 태그 제거
- name 의 대문자 → 소문자 변환
- 빈 줄 / trailing whitespace
- 참조 파일 path 의 잘못된 깊이 (warning 만)
- **PEP 723 헤더 자동 추가** — 외부 import 있는데 헤더 없는 .py 에 헤더 삽입
- **PEP 723 deps drift 자동 정리** — import ↔ deps 차이 양쪽 정렬 (누락 추가 + dead 제거)
- **SKILL.md 호출 자동 치환** — `python3 <path>.py` → `uv run --script <path>.py` (외부 deps 있을 때만)

수동 fix 가 필요한 항목 (description 내용 보강, 본문 재구조 등) → 사용자에게 보고 + 제안.

### 4. 결과 보고

```markdown
## Validation: <name>

### Summary
- **Status**: PASS | PASS-WITH-WARN | FAIL
- **Errors**: N
- **Warnings**: N
- **Auto-fixed**: N (if --fix)

### Issues

#### Errors
1. **<title>** at line N
   - Problem: ...
   - Fix: ...

#### Warnings
...

### Recommendations
- ...
```

## Examples

```
/skill-architect validate skills/managed/pptx-template
→ Status: PASS-WITH-WARN
  Warnings: 2 (description 에 "NOT for" 누락, allowed-tools 미명시)

/skill-architect validate /workspace/.tower/skills/pptx-template --fix
→ Auto-fixed 1 (frontmatter trailing whitespace)
  Manual fix needed: 2 warnings (위와 동일)
```

## Related

- 검증 본체: `../validation.md`
- spec: `../spec.md`
- create 의 Phase 4: `cookbook/create.md`
- 디렉토리 일괄: `cookbook/audit.md`
