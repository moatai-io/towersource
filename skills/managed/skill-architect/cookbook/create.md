# /skill-architect create — 새 command/skill 만들기 end-to-end

사용자-facing 실행 단위는 **Command**다. 이 cookbook은 먼저 만들 대상이 `code command`인지 `AI skill command`인지 분류한다. 기존 5-phase 스킬 워크플로우는 **AI skill command** 분기에 적용된다. 별도 `workflow command` 분류는 두지 않고, 여러 단계가 필요한 작업은 AI skill 내부 process로 설계한다.

AI skill command는 **첫 시도 완벽하지 않다는 전제로 설계됨** — Phase 3 (smoke test) 에서 거의 항상 fail 하고, fail 이 학습이 되어 Phase 2 round 2 로 돌아간다. 그 사이클이 "정말 좋은 스킬" 의 핵심.

> 한 번에 잘 만든다는 건 환상이다. **첫 시도에 잘 만들어지고, 반복으로 다듬어진다.** 이 cookbook 은 그 두 가지를 한 흐름에 담는다.

## 진행 상태 관리

`ProcessMapWrite`는 기본 skill-architect 실행 경로에서 사용하지 않는다. Process Map side panel과 기본 tool surface는 산만함과 중복 tool call을 줄이기 위해 legacy로 내려갔다. 이 cookbook은 진행 관리를 `TodoWrite`와 최종 handoff 중심으로 한다.

스킬 제작 중 사용자가 확인해야 하는 것은 별도 Process Map이 아니라 최종 산출물의 핵심 계약이다. 필요한 경우 최종 응답 또는 handoff에 아래 내용을 짧게 요약한다.

```text
- 스킬 목적 / JTBD
- 트리거와 비트리거 경계
- 기본 실행 흐름
- 산출물 계약
- 검증 기준 / 향후 샘플
```

세부 파일 읽기·grep·테스트 실행은 TodoWrite의 operational checklist에 두고, 사용자가 볼 결과는 최종 요약과 산출물 경로로 인계한다. 반복 자동화 후보나 run-level phase view는 향후 hierarchical Run Graph / 자동 roll-up UI가 생긴 뒤 재검토한다.

## When this runs

- 사용자가 "스킬 만들어", "커맨드 만들어", "new skill", "new command", "/skill-architect create <name>" 등으로 신규 실행 입구를 요청
- 자연어 트리거 ("PPTX 처리 스킬 있으면 좋겠다", "이런 slash command 있으면 좋겠다") 도 모두 이 cookbook 으로 들어와야 함
- 이미 디스크에 같은 이름이 있으면 → `/skill-registry register-local/doctor` (등록·가시성) 또는 `/skill-architect refine` (개선) 로 분기. Moat system catalog 등록일 때만 `/library add`.

## Arguments

```
/skill-architect create <name> [kind|type] [tags]
```

- **`<name>`**: 소문자 + 하이픈 (e.g. `pptx-edit`, `slack-poster`)
- **`[kind]`**: `code | ai` — command 구현 종류. 미지정 시 Phase 0에서 판정한다.
- **`[type]`**: AI skill command일 때만 `reference | task | file-writing | multi-agent` — 기본 `task`. 자세한 분류는 현재 스킬 번들의 `classification.md`를 참조한다. Project Runtime Box에서는 `/workspace/.tower/skills/skill-architect/classification.md`가 기준이다.
- **`[tags]`**: `core / business / docs / browser / presentation / dev / meta / tower-ops / internal` 콤마 구분. 미지정 시 Phase 4 에서 사용자에게 묻기

---

## Phase 0: Command kind 분류

**목적**: 사용자가 만들고 싶은 것이 실제로 어떤 command인지 먼저 정한다. "스킬"이라는 말이 들어가도 무조건 SKILL.md부터 만들지 않는다.

질문은 짧게 한다.

> "이 `/...` 실행 입구는 AI가 판단·작성·도구 사용을 해야 하나요, 아니면 앱 코드가 정해진 동작만 하면 되나요?"

판정표:

| Kind | 만들 것 | 예 | 이 cookbook의 다음 경로 |
|---|---|---|---|
| `code command` | backend/frontend handler + command registry entry | `/skills`, `/task list`, `/compact` | 코드 변경 설계로 전환. 일반 사용자/project runtime에서는 직접 생성하지 않음 |
| `AI skill command` | `SKILL.md` package + command entry | `/meeting-prep`, `/pptx-template` | Phase 1 이하 계속 진행 |

가드레일:

- `code command`는 앱 권한면이므로 backend-controlled다. 일반 프로젝트 스킬처럼 self-service로 만들지 않는다.
- 여러 단계, 도구 사용, 문서 생성, 판단 절차가 필요한 작업은 별도 workflow kind가 아니라 `AI skill command` 내부 process로 설계한다.
- 사용자가 원하는 일이 AI 절차·판단·작성·분석·도구 사용을 포함하면 `AI skill command`로 진행한다.
- Agent 호출 모델은 이 cookbook의 command kind 분류에서 제외한다.

이후 문서의 "스킬"은 대부분 `AI skill command`를 뜻한다.

---

## Project-first rule (2026-06-10)

사용자가 그냥 “스킬 만들어”라고 하면 기본값은 **현재 프로젝트 스킬 (`scope=project`)** 이다. 사용자-facing 스킬의 진실은 프로젝트 안에 있어야 한다: Tower가 설치한 기본 스킬은 `.tower/skills`, 프로젝트 팀이 만든 스킬은 `skills/`다. `personal` DB 스킬은 deprecated/legacy-inert이며 새로 만들지 않는다. 특히 `.claude`는 legacy compatibility/fallback/output 경로일 뿐 managed source/catalog SSOT가 아니다.

프로젝트 스킬 생성 경로:

1. 현재 프로젝트 context를 확인한다. 없으면 어느 프로젝트에 속할지 물어본다.
2. 이름과 JTBD 한 줄을 받는다.
3. `projects/<project>/skills/<name>/SKILL.md`를 만든다. 멀티파일이면 같은 폴더 아래 `scripts/`, `examples/`, `reference.md`를 둔다.
4. manifest/register/materialize를 필수 관문으로 두지 않는다. 프로젝트 로컬 `skills/<name>/SKILL.md`가 있으면 그 프로젝트의 slash command 후보가 되어야 한다.
5. slash command 후보에서 보이는지 확인한다.
6. “이 프로젝트에서 `/<name>` 후보로 사용할 수 있습니다”라고 안내하고 멈춘다.

프로젝트 스킬 경로에서 **하지 말 것**:

- `scope: "personal"` DB 스킬 생성
- `skills/managed/<name>/` 생성
- legacy `local-library.yaml` 수정
- `/library add` 호출
- `config/skills/managed-skills.yaml` 또는 `skills/managed/<name>/` 수정
- `/skill-registry register-local` 호출
- 프로젝트 로컬 스킬을 쓰기 위해 `.tower/skills/manifest.json` 갱신을 요구
- fleet/self-hosted server 배포 이야기로 즉시 확장

회사 기본 스킬로 승격해야 할 때만 별도 사용자 확인 후 managed source (`skills/managed/<name>/` + `config/skills/managed-skills.yaml`)로 옮긴다.

근거: `~/workspace/decisions/2026-06-10-project-scoped-skills-as-user-facing-ssot.md`

---

## Phase 1: Genesis — JTBD 한 줄 합의

**목적**: 만들기 전에 "이 스킬이 어떤 상황에서, 누구의, 어떤 일을 대신하는가" 를 한 줄로 박는다. 이 한 줄이 description / trigger / NOT for 의 골격이 된다.

### 1.1 사용자에게 한 줄 정의 + scope 확인

먼저 현재 프로젝트 context를 확인한다. 기본값은 project 이므로 길게 선택지를 늘어놓지 않는다.

> "기본은 현재 프로젝트 스킬로 만들겠습니다. 회사 기본 스킬로 배포할 목적이면 말씀해주세요."

그 다음 JTBD 한 줄을 받는다.

> "이 스킬은 한 줄로 어떤 일을 합니까? 'X 상황에서 Y 가 Z 를 대신해준다' 형식으로."
>
> 예: "사용자가 기존 .pptx 를 열어서 텍스트/이미지/표만 바꾸고 싶을 때, AI 가 master/layout/theme 을 보존하면서 native editable .pptx 를 출력해준다." (= pptx-edit)

답이 모호하면 ("PPTX 다루는 거") **여기서 멈추고** ideate skill 활성화 또는 사용자에게 더 좁힌 정의 요청. JTBD 모호하면 Phase 2 의 description 도 모호해지고 자동 트리거도 부정확해짐.

### 1.2 기존 스킬과 중복/유사 검사

```bash
# Tower-owned managed catalog 검색
python3 - <<'PY'
import re, yaml
from pathlib import Path
keywords = re.compile(r"<keyword1>|<keyword2>", re.I)
cat = yaml.safe_load(Path("config/skills/managed-skills.yaml").read_text())
for s in cat.get("library", {}).get("skills", []):
    text = " ".join(str(s.get(k, "")) for k in ["name", "description", "tags"])
    if keywords.search(text):
        print(s["name"], "—", s.get("description", "")[:160])
PY

# 또는 repo-managed source 본문 검색
grep -R -l -E "<JTBD-keyword>" skills/managed/*/SKILL.md skills/*/SKILL.md 2>/dev/null
```

기존 비슷한 스킬 발견 시 사용자에게 보고 + 분기 제안:
- (a) 기존 스킬 확장 → `/skill-architect refine <existing>`
- (b) 새 스킬로 가되, NOT for 로 경계 명시 (Phase 2 에서)
- (c) 그만

**예시**: "PPTX 처리" 검색 → 기존에 `image-slide-gen` 발견 → 새 `pptx-edit` 는 "기존 파일 편집" 으로 좁히고 image-slide-gen NOT for 명시.

### 1.3 이름 충돌 확인

```bash
# managed/system source 충돌
[[ -d "skills/managed/<name>" ]] && echo "managed source already exists"
[[ -d "skills/<name>" ]] && echo "operator skill already exists"

# managed catalog 충돌
python3 - <<'PY'
import yaml
from pathlib import Path
cat = yaml.safe_load(Path("config/skills/managed-skills.yaml").read_text())
print(any(s.get("name") == "<name>" for s in cat.get("library", {}).get("skills", [])))
PY
```

존재하면 → `/skill-registry doctor` 또는 `/skill-architect refine` 으로 분기. Managed/default 고객 배포 대상이면 `skills/managed/<name>/` + `config/skills/managed-skills.yaml`을 고친 뒤 deploy/materialize한다.

### 1.4 Host context 감지 + naming 권고 (customer host 한정)

이 단계는 **self-hosted server 또는 member/project Runtime Box에서 실행 중일 때만** 적용. 본 서버 repo 작업이면 skip.

**Host 감지**:
- Project Runtime Box/프로젝트 세션에서 새로 authoring하는 스킬의 기본 source는 `/workspace/skills/<skill>/SKILL.md` 또는 host 기준 `projects/<project>/skills/<skill>/SKILL.md`다.
- `/workspace/.tower/skills/manifest.json`와 `/workspace/.tower/skills/<skill>/`는 managed/team skill materialization provenance와 충돌 확인용 metadata/source다. 프로젝트 로컬 `skills/<skill>/SKILL.md` 사용 가능 여부의 필수 관문이 아니다.
- Operator repo 세션에서는 `config/skills/managed-skills.yaml`와 `skills/managed/<skill>/`가 managed source/catalog SSOT다.
- Legacy `.claude` catalog/header는 compatibility signal로만 보고, 새 source 위치 판단의 기준으로 쓰지 않는다.

**Customer host 일 때 — 이름 권고**:

> "이 VM 은 managed 고객 환경입니다. 본 서버에서 우리가 같은 이름의 스킬을 만들어 publish 하면 여러분 작품이 덮어써집니다.
>
> 이름 충돌을 피하기 위해 다음 중 하나의 prefix 권장:
> - `local-<name>` — 이 VM 안에서만 쓰는 스킬임을 명시
> - `<team>-<name>` — 회사/팀 명을 prefix (예: `acme-report`)
>
> 그래도 우리 manifest 와 같은 이름을 쓰고 싶다면 자율, 다만 다음 publish 시 손실 위험 명시."

**우리 manifest 와 충돌 검사**:
```bash
# Project Runtime Box의 materialized manifest에 같은 이름이 있나?
test -f /workspace/.tower/skills/manifest.json && \
  jq -r '.skills[].name // empty' /workspace/.tower/skills/manifest.json | grep -x "<proposed-name>"
```
충돌하면 → 사용자에게 강력히 prefix 권고. 그래도 같은 이름 고집 시 → 진행하되 SKILL.md 안에 "⚠️ Conflicts with operator-managed skill of the same name; will be overwritten by next publish" 코멘트 박기.

---

## Phase 2: Scaffold + Trigger 합의

**목적**: 파일 골격 만들고, **description 을 Phase 1 의 JTBD 그대로 반영**. 트리거는 자연어 정확도가 핵심.

### 2.1 Type 결정

현재 스킬 번들의 `classification.md` 참조. Project Runtime Box에서는 `/workspace/.tower/skills/skill-architect/classification.md` 참조:
- `reference` — 배경 지식·관례 (예: agent-sdk-reference)
- `task` — 단계별 액션 (예: pptx-edit, send-sms) ← **default**
- `file-writing` — 파일을 생성/수정 (executing plan 단계 포함)
- `multi-agent` — 여러 agent / external CLI 오케스트레이션

### 2.2 Scaffold (인라인 — skill-architect 흡수됨)

현재 스킬 번들의 `templates.md` type별 템플릿을 참조하되, **scope에 따라 저장 위치가 다르다**. Project Runtime Box에서는 `/workspace/.tower/skills/skill-architect/templates.md`를 참조한다.

#### Project 기본 경로

프로젝트 스킬은 파일 기반으로 만든다. 단일 파일이면 `SKILL.md`만, 멀티파일이면 같은 폴더 아래 보조 파일을 둔다. 이 경로는 manifest 없이 즉시 slash command discovery 대상이다.

```text
projects/<project>/skills/<name>/
└── SKILL.md
```

#### Managed / operator 경로

사용자가 명시적으로 회사 기본 스킬, 자체 호스팅 서버 배포, managed/system skill을 원하면 별도 확인 후 file-backed managed/operator 경로로 간다.

```
# Managed/default 고객 배포 대상 — Tower repo source/catalog SSOT
skills/managed/<name>/
└── SKILL.md
config/skills/managed-skills.yaml

# Operator/dev-only Tower repo skill
skills/<name>/
└── SKILL.md

# Project-local file-backed skill (user/team authored)
projects/<project>/skills/<name>/
└── SKILL.md

# Materialized managed/team skill metadata/source, not a required gate for local authoring
projects/<project>/.tower/skills/<name>/
└── SKILL.md
```

`SKILL.md` frontmatter:
```yaml
---
name: <name>
description: |
  <Phase 1 의 JTBD 한 줄 + "Use when ..." + "NOT for ...">
version: 1.0.0
tags: [<chosen-tag>]
argument-hint: "[optional-args]"
# Optional: add at most one Korean alias only when it clearly helps users.
# slash-aliases:
#   - /<natural-korean-alias>
---
```

`slash-aliases`는 새 스킬의 discoverability 보조 장치다. **기본은 canonical `/<name>` 하나만 쓴다.** 영어 이름만으로 충분하면 alias를 만들지 않는다.

한글 사용자가 자연스럽게 칠 표현이 분명할 때만 한글 alias 1개를 추가한다. 예: `/회의준비`, `/피피티수정`. 여러 alias를 만들지 않는다. alias가 많으면 picker가 복잡해지고 사용자가 어떤 이름을 써야 할지 혼란스러워진다.

단, alias는 **스킬 alias까지만** 만든다. 새 `.tower/commands/*.command.yaml` native/code command manifest는 사용자가 명시적으로 요구하고 별도 안전 검토가 있기 전에는 만들지 않는다.

본문은 type 별로 다름. `skill-templates.md` 의 해당 type 섹션을 그대로 모사.

### 2.3 Description 작성 (트리거 정확도가 핵심)

description 은 자동 트리거의 모든 것. 4 부분으로 구성:

| 부분 | 내용 | 예 (pptx-edit) |
|---|---|---|
| **What** | JTBD 한 줄 | "Edit existing .pptx files using python-pptx — modify text/images/tables/notes while preserving master/layouts/theme." |
| **Use when** | 자연어 트리거 (한국어 + 영어 혼합 OK) | "PPTX 편집", "PPT 수정", "기존 슬라이드 텍스트 바꿔", "edit pptx" |
| **NOT for** | 비슷한 다른 스킬과의 경계 | "이미지 기반 새 슬라이드 생성 (→ image-slide-gen), 이미지 기반 PDF가 필요하면 → image-slide-gen" |
| **Companion** (옵션) | 동행/대체 스킬 | "Companion to image-slide-gen which generates image-based slides from scratch" |

**규칙**:
- "Use when" 의 자연어는 사용자가 실제 말할 만한 표현 — 머릿속 영어 직역 X
- 한국어 / 영어 트리거 같이 둘 것 (다국어 환경)
- 1024자 제한, XML 태그 금지, 3인칭 voice
- 자세한 검증: `../validation.md`

### 2.4 트리거/alias 충돌 검사

기존 스킬의 description 과 cross-grep 으로 키워드 충돌 검사:

```bash
# 새 스킬의 트리거 키워드 추출 후
for kw in "PPTX 편집" "PPT 수정" "edit pptx"; do
  echo "=== $kw ==="
  grep -R -l "$kw" skills/managed/*/SKILL.md skills/*/SKILL.md 2>/dev/null | grep -v "<new-name>"
done
```

다른 스킬도 같은 트리거를 갖고 있으면 → 둘 중 하나 좁혀야 함:
- 새 스킬의 description 에 "NOT for: ... (→ <existing>)" 추가
- 또는 기존 스킬의 description 에 "NOT for: ... (→ <new>)" 추가 (refine 별도 cookbook)

→ 충돌 미해결 시 Phase 3 의 smoke test 가 잘못된 스킬을 부르게 됨.

한글 alias를 추가했다면 충돌 검사한다. 새로 넣을 `slash-aliases`가 기존 skill/native command와 겹치면 안 된다. 특히 `/compact`, `/task list`, `/skill-architect` 같은 system/managed command와 충돌 금지.

간단 검사 예:

```bash
# repo/operator host 기준. project runtime에서는 materialized skills/manifest 기준으로 유사 검사.
alias="/회의준비"
grep -R -n "${alias#/}" skills/managed/*/SKILL.md skills/*/SKILL.md projects/*/skills/*/SKILL.md 2>/dev/null || true
```

alias가 충돌하면 alias를 빼거나 다른 한글 alias 1개로 바꾼다. 영어 alias를 추가로 늘려 해결하지 않는다.

### 2.5 보조 파일 (필요 시)

`task` 또는 `file-writing` 류면 보통:
- `scripts/` — 실행 가능 스크립트 (Python/Bash)
- `examples/` — sample input/output
- `reference.md` — API 레퍼런스, 패턴 모음 (SKILL.md 너무 두꺼워지지 않게 분리)

크기 가이드:
- SKILL.md: ≤ 500 줄 (validation.md 의 best practice)
- reference.md: 무제한 (lazy load — 호출 시점에만 읽음)

### 2.5.1 Python 스크립트 표준 — PEP 723 + uv run --script (필수)

`scripts/` 안에 Python 스크립트를 만들면 **반드시 PEP 723 inline metadata 헤더**를 박아야 한다. 시스템 python 에 의존 X — 격리 venv 안에서만 deps 쓰고, 시스템 site-packages 는 깨끗하게 유지한다. 이게 D11/D12 의 sandbox 격리 정신을 스킬 레벨까지 확장한 것.

**스크립트 헤더 형식** (shebang 다음, docstring 전):

```python
#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "openai>=1.50",
#   "python-pptx>=1.0",
# ]
# ///
"""
my_script.py — short purpose line.
"""

import argparse
from openai import OpenAI
from pptx import Presentation
...
```

**SKILL.md 의 호출 패턴**:

```bash
# ❌ 금지 — 시스템 python 의존
python3 /workspace/.tower/skills/<name>/scripts/my_script.py <args>

# ✅ 표준 — Project Runtime Box/materialized skill 기준
uv run --script /workspace/.tower/skills/<name>/scripts/my_script.py <args>

# ✅ repo 검증 중이면 source 경로에서 직접
uv run --script skills/managed/<name>/scripts/my_script.py <args>
```

**왜 이 형식인가**:
- **격리** — 매 실행 ephemeral venv. 다른 스킬과 deps 충돌 없음.
- **속도** — uv 는 pip 보다 10-100배 빠름. cold cache 1-2초, warm cache 즉시.
- **재현성** — 의존성이 스크립트 파일 자체에 박혀있어 버전 명시적.
- **단일 파일** — pyproject.toml 따로 없이 self-contained.
- **시스템 오염 X** — `pip install --user` 안 함. 시스템 python 깨끗하게 유지.

**의존성 명시 팁**:
- 패키지명은 *PyPI 이름* (import 이름 아님). 예: `from PIL import Image` → `pillow`. `from google import genai` → `google-genai`. `import yaml` → `pyyaml`.
- 외부 deps 가 *없으면* PEP 723 헤더 생략 가능 (그냥 `python3 ...` 호출). 단 일관성 위해 박아도 무해.
- minimum 버전 (`>=X.Y`) 권장. 상한 (`<Z`) 은 호환성 깨질 때만.

**실행 환경 전제**:
- operator host 와 모든 self-hosted server 에 `uv` 설치돼 있음 (Tower fleet 표준, 2026-05-08 이후).
- 부재 시 `pip install --user uv` (~30초). `/skill-registry-orchestration sync` 흐름이 self-hosted server 에 자동 보장.

근거: `workspace/decisions/2026-05-08-skill-uv-pep723-standard.md`

### 2.5.2 Runtime portability — Tower-specific 실행 구조를 스킬에 박지 않기

스킬은 Tower 밖에서도 독자 생존해야 한다. 스킬 본문은 도메인 절차·품질 기준·입출력 구조를 제공하고, 실행 위치·권한·격리 방식은 현재 runtime/system prompt/tool guard 가 주입한다고 가정한다.

**스킬 본문에 박지 말 것**:
- `mcp__sandbox__run`, `sandbox.tool.start` 같은 Tower-specific tool name
- `workspace/projects/<p>/published/<slug>` symlink 생성 같은 Tower publishing 내부 구조
- 특정 self-hosted server 이름, Tower host, fleet 내부 경로
- "Tower 에서는 반드시 X 도구로 실행"처럼 runtime 을 고정하는 문장

**portable wording 예시**:

```md
실행이 필요하면 현재 환경이 승인한 실행 경로를 사용한다.
장시간 실행되는 서비스는 현재 환경의 persistent tool/runtime 등록 경로를 따른다.
정적 산출물은 현재 환경의 publishing 규칙에 맞춰 배치한다.
외부 의존성·네트워크·비밀값이 필요한 경우 현재 환경의 승인된 격리 실행 정책을 따른다.
```

**예외**: `fleet`, `library`, `selfheal`, `tower-guide-update` 처럼 Tower 운영 자체가 목적이고 Tower 밖 portable survival 이 목표가 아닌 운영 전용 스킬은 Tower-specific 절차를 포함할 수 있다. 그래도 가능한 한 결정문서와 runtime contract 를 링크하고, 스킬 본문에 중복 정책을 길게 복사하지 않는다.

근거: `workspace/decisions/2026-05-26-skill-portability-and-runtime-execution-contract.md`

---

## Phase 3: Smoke Test — 즉시 실 호출 (가장 중요한 단계)

**목적**: 만든 직후 진짜 워크플로우로 1-2개 시나리오 실행. 거의 항상 fail. **fail 이 정상이고, fail 의 패턴이 다음 라운드의 학습 재료**.

> 이 단계를 건너뛰면 배포 후 사용자가 발견. 만든 그 자리에서 catch 하는 게 50배 싸다.

### 3.1 시나리오 작성 (사용자에게 묻기)

> "이 스킬을 처음 쓸 1-2개 실제 시나리오를 짧게 적어주세요. 입력 / 기대 출력 형식으로."
>
> 예 (pptx-edit):
> 1. "tower-offer-template.pptx 를 열어서 5 페이지 KPI 표의 매출 숫자 3 개를 갱신, 결과 .pptx 저장"
> 2. "고객사 자기소개 PPT 의 회사 이름을 모두 'Acme' 로 일괄 치환"

시나리오는 사용자의 머릿속에 이미 있음 (만들 동기). 추출만 하면 됨.

### 3.2 트리거 정확도 테스트

```bash
# 시나리오의 자연어 (사용자가 실제 말할 표현) 로 모델 호출
# Tower 의 별도 채널 또는 새 세션에서 dry-run
"안녕, [시나리오 1 의 자연어 표현]"
```

확인:
- ✅ 의도한 스킬이 자동 트리거되는가? (description 의 "Use when" 정확도)
- ✅ 다른 비슷한 스킬이 잘못 트리거되지 않는가? (NOT for 정확도)

**Fail 패턴**:
- 다른 스킬이 부름 → description 의 "Use when" 너무 약함, 또는 "NOT for" 누락 → Phase 2.3 round 2
- 아무것도 안 부름 → description 너무 좁음, 한국어 트리거 누락 → Phase 2.3 round 2

### 3.3 작동 정확도 테스트

트리거가 맞으면 → 실제 결과 검증:

- ✅ 예상 산출물이 나오는가?
- ✅ 실패 시 cookbook 의 "Failure modes" 섹션에 잡혔는가?
- ✅ 의존성 (외부 CLI, Python 패키지, API 키) 사전 확인 안내가 있는가?

**Fail 패턴**:
- 스크립트 에러 → SKILL.md 의 prerequisites 보강
- 결과 부정확 → 본문 instruction 보강
- 모호한 분기 → SKILL.md 안에 분기 조건 명시 (예: 입력이 .pptx 가 아니면 거부)

### 3.4 Round 결정

- **PASS** (트리거 + 작동 둘 다) → Phase 4 로
- **FAIL 1-2 군데** → 그 자리에서 fix → 같은 시나리오 재실행
- **FAIL 3+ 군데** → Phase 2 round 2 로 (description 부터 재설계)

3-5회 라운드 후에도 PASS 안 나오면 → JTBD 자체가 모호하거나 너무 큼. Phase 1 로 회귀해서 좁히기.

---

## Phase 4: Validate + Register

**목적**: 품질 게이트 통과 후 카탈로그 등재.

### 4.1 Validate (인라인)

현재 스킬 번들의 `validation.md` 체크리스트 적용. Project Runtime Box에서는 `/workspace/.tower/skills/skill-architect/validation.md` 기준:

- frontmatter: name (lowercase + hyphen, 예약어 X), description (≤ 1024자, XML 없음, 3인칭), version, tags, argument-hint, slash-aliases
- structure: SKILL.md ≤ 500줄, reference 파일 ≤ 1 level 깊이, 참조 파일 존재
- best practice: file-writing 류는 execution plan 단계 있음, allowed-tools 명시 (필요 시), portable 스킬 본문에 Tower-specific 실행 구조를 직접 박지 않음

`slash-aliases` validation:
- alias는 필수가 아니다. canonical `/<name>`이 기본 slash command다.
- 영어 command 하나로 충분하면 `slash-aliases`를 비워둔다.
- 한글 사용자가 분명히 더 쉽게 부를 표현이 있을 때만 한글 alias 1개를 둔다.
- alias가 2개 이상이면 줄인다. 예외는 사용자가 명시적으로 여러 alias를 요구한 경우뿐이다.
- alias가 기존 command와 충돌하면 수동 수정 필요. 충돌 해결을 위해 alias를 늘리지 않는다.

자동 fix 가능한 항목 (들여쓰기, 빈 줄, frontmatter format 등) 은 그 자리에서 수정. 수동 fix 필요한 건 사용자에게 보고.

PASS 안 나오면 fix 후 재 validate. WARN 은 통과 OK, ERROR 는 통과 X.

### 4.2 Tag 결정 (인자 미지정 시)

> "이 스킬을 어느 카테고리에 둘까요?
> - `core` (모두에게 기본 노출)
> - `business` (비즈니스 도구)
> - `docs` (문서·콘텐츠)
> - `presentation` (슬라이드, self-hosted VM 만)
> - `browser` (브라우저, managed 만)
> - `dev / meta / tower-ops / internal` (우리만)
> 모르면 `business` 추천."

태그는 검색/분류용이다. 배포 정책은 가능하면 `distribution.profiles` 로 명시한다.

### 4.3 Registry/Catalog 등록 — scope 별 분기

스킬 생성의 완료 조건은 **현재 사용자/VM 에서 보이도록 등록·가시성을 확인하는 것**이다. 자체 호스팅 서버 에서는 사용자에게 `/library add` 를 따로 시키지 않는다.

#### A. Project (기본값)

프로젝트 스킬은 현재 프로젝트 안의 `skills/<name>/SKILL.md`로 저장한다. 이 경로가 사용자-facing project-local SSOT다. DB-backed project skill API는 호환용으로 남아 있지만, 새 authoring은 파일 기반 project skill을 우선한다. `.tower/skills/manifest.json`은 managed/materialized skill의 provenance·충돌 확인 metadata일 뿐, 프로젝트 로컬 스킬 사용 가능 여부의 필수 관문이 아니다.

```text
projects/<project>/skills/<name>/
└── SKILL.md
```

검증:

```bash
# project root에서
find skills -mindepth 2 -maxdepth 2 -name SKILL.md | sort
```

안내 문구:

> "프로젝트 스킬로 저장했습니다. 이 프로젝트에서 `/<name>` 후보로 사용할 수 있습니다."

#### B. Personal (deprecated)

새 개인 스킬은 만들지 않는다. 기존 `skill_registry(scope='personal')` 행은 legacy-inert로 남길 수 있지만 slash command, session prompt, runtime skill path에 노출하지 않는다.

#### C. Operator host (본 서버 / full) 의 managed/company/system

두 갈래를 구분한다.

1. **Default managed/customer 배포 대상**이면 `skills/managed/<name>/SKILL.md`를 만들고 `config/skills/managed-skills.yaml`의 `library.skills:`에 추가한다. 이것이 managed source/catalog SSOT다.
2. **Operator/dev-only Tower skill**이면 `skills/<name>/SKILL.md` 아래에 둔다. 자체 호스팅 서버 기본 배포 대상이 아니면 `config/skills/managed-skills.yaml`에 넣지 않는다.

Managed catalog entry 예시:

```yaml
- name: <name>
  owner: moat
  tier: team
  version: 1.0.0
  description: <SKILL.md description 첫 줄 또는 한국어 요약>
  source: skills/managed/<name>/SKILL.md
  distribution:
    profiles: [managed, full]
    customer_safe: true
  tags:
    - <chosen-tag>
```

검증:

```bash
scripts/skills/deploy-managed-skills.sh --dry-run managed
node --import tsx - <<'JS'
import { getLibrarySkill } from './packages/backend/services/skill/library-skills.ts';
console.log(getLibrarySkill('<name>'));
JS
```

#### D. Self-hosted server / Project Runtime Box 의 project-local

Customer/project-local skill 로 명시된 경우에는 project-local source 경로에 둔다. Operator-managed catalog는 건드리지 않는다.

```text
/workspace/skills/<name>/SKILL.md
```

의미:
- 이 프로젝트 Runtime Box 안에서만 보이는 local skill
- `skills/<name>/SKILL.md`가 있으면 manifest 없이 slash command 후보가 된다
- managed deploy/materialization 이 같은 이름을 다시 materialize하면 충돌 가능
- `.tower/skills/manifest.json`은 managed/materialized skill provenance·충돌 확인용 metadata다
- 전역 `legacy provider account` 계정 디렉토리는 ownership 단위가 아니므로 새 source로 쓰지 않는다

충돌 규칙:
- `/workspace/.tower/skills/manifest.json` 에 같은 이름이 있으면 managed skill override 가능성이 있으므로 사용자에게 알리고 prefix를 권고한다. 그래도 같은 이름을 원하면 `skills/<name>/SKILL.md`의 project-local이 우선하지만, 의도적 override임을 SKILL.md 상단 주석이나 보고에 남긴다.

### 4.4 후속 단계 안내

Operator host:
> "등록 완료. 현재 VM 가시성은 `/skill-registry doctor <name>` 로 확인하면 됩니다. 자체 호스팅 서버 전파가 필요하면 먼저 `/skill-registry-orchestration diff <customer>` 를 보겠습니다. Moat system catalog/GitHub backup 만 필요하면 `/library` 경로를 씁니다."

Self-hosted server:
> "등록 완료. 이 스킬은 이 VM 안에서만 사용됩니다. slash menu 에 보이는지 확인하고, 필요하면 운영자에게 upstream 승격을 요청할 수 있습니다."

---

## Phase 4.5: Secrets — 외부 API 키 의존 검사 (★ 자주 누락)

**목적**: 스킬이 OpenAI / Gemini / Slack / Notion 같은 외부 API 키를 사용한다면, self-hosted server 배포 시 키 부재로 첫 호출에서 fail. **publish 전에 secrets 신고 + 배포 절차 통과해야 함.**

### 4.5.1 의존성 검사

스킬의 SKILL.md / scripts / examples 안에 다음 패턴 grep:
```bash
grep -rE "API_KEY|TOKEN|SECRET|os\.environ\[|process\.env\." skills/managed/<name>/ skills/<name>/ 2>/dev/null | head -10
```

발견되는 키 이름 목록을 사용자에게 확인:
> "이 스킬이 다음 외부 키들을 참조합니다: `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`. 맞나요?
> 맞다면 Credential Vault grant와 managed catalog metadata가 필요합니다."

검사 안 해도 됨 (의존성 0개) → Phase 4.5 skip, Phase 5 로.

### 4.5.2 managed catalog 의 runtime_requirements.secrets 에 신고 (declarative)

operator host 라면 — 의존하는 키 이름을 `config/skills/managed-skills.yaml`의 해당 skill entry에 추가한다. 값은 절대 쓰지 않고 이름만 쓴다.

```yaml
# config/skills/managed-skills.yaml
- name: <name>
  runtime_requirements:
    execution: optional
    network: required
    persistence: none
    secrets:
      - OPENAI_API_KEY
      - <NEW_KEY>
  risk:
    uses_secrets: true
    can_send_external: true
```

이 declaration 은 **skill dependency metadata**다. 실제 값은 Tower Credential Vault가 Runtime Box 환경변수로 주입한다. `.env`, `~/.env`, host-global skill path를 읽게 만들지 않는다.

### 4.5.3 값 grant / 배포

값은 이 cookbook이 받거나 출력하지 않는다. 사용자가 직접 Credential Vault에 저장/grant하거나, 운영자 전용 secret 배포 절차를 사용한다. Project Runtime Box에서 확인할 때도 값 없는 presence check만 한다.

```bash
python3 - <<'PY'
import os
for key in ["OPENAI_API_KEY", "<NEW_KEY>"]:
    print(f"{key}=present-redacted" if os.getenv(key) else f"{key}=missing")
PY
```

금지:
- `env`, `printenv`, `cat .env`, `grep ~/.env`
- secret 값을 user/assistant 메시지에 출력
- 스킬 코드가 host `.env` fallback을 읽게 만들기

### 4.5.4 검증

```bash
# 키 존재 확인 (값은 redact 됨)
"$SCRIPT" "$TARGET" --list

# 특정 키만
"$SCRIPT" "$TARGET" --check OPENAI_API_KEY  # exit 0 = present
```

스킬 자체에 `load_api_key()` 같은 로더가 있으면 우선순위는 환경변수/Credential Vault 주입만 허용한다. host `.env`, project `.env`, `~/.env`, `~/.config/tower/keys.env` fallback을 넣지 않는다.

### Customer host 일 때

Credential Vault grant가 없으면 운영자에게 Vault 설정/권한 부여를 요청한다. customer/member host에서 host `.env`를 직접 읽거나 수정하지 않는다.

### 누락 시 증상

- publish 후 첫 호출에서 `KeyError: OPENAI_API_KEY` 또는 401 Unauthorized
- 사용자가 "이 스킬이 안 먹어요" 보고
- 디버깅: Credential Vault grant/presence check가 missing으로 나오는지 확인

이 단계 skip 하면 publish 후 발견되어 50배 비싸짐 — Phase 3 (Smoke test) 와 같은 원리.

---

## Phase 5: Real Use (deferred — 별도 cookbook)

**목적**: 실 사용 1-2 주 후 발견되는 미세 조정. 만들 당시엔 catch 못 한 패턴.

이 phase 는 `cookbook/refine.md` 로 분리. 트리거:
- 사용자가 "이 스킬 좀 이상해" 라고 다시 부를 때
- audit 에서 문제 발견 시
- 새 사용 시나리오 발견 시

→ `/skill-architect refine <name>` 호출 → refine cookbook 의 단계 (관찰 → distill → 재 validate → 재배포).

---

## Examples

### 좋은 흐름 (PASS in 1 round)

```
사용자: "Slack 채널에 정해진 양식으로 일일 보고 보내는 스킬"
AI:    Phase 1 — JTBD 한 줄: "사용자가 일일 보고 데이터 (JSON) 를 주면 정해진 양식 (한국어 헤더 + 표) 으로 Slack 채널에 자동 발송"
       기존 스킬 검색 → send-sms 발견하지만 SMS 한정. 충돌 X.
       이름: slack-daily-report (사용자 OK)
Phase 2 — type=task. scaffold. description = JTBD + "Use when 일일 보고 / 데일리 리포트 / Slack 일보" + "NOT for 일반 메시지 (→ slack-send-message)".
Phase 3 — Smoke test "오늘 데일리 보내줘 [JSON 첨부]" → 정확히 트리거 + 산출 OK. PASS.
Phase 4 — validate PASS. tag=business. /skill-registry 로 current VM 등록·가시성 확인.
Phase 5 — 사용자: "지금 self-hosted VM 까지" → /skill-registry-orchestration diff managed 대상 확인 후 sync.
```

### 흔한 흐름 (Round 2-3 에서 PASS)

```
Phase 3 round 1 — "보고서 보내" 호출 → image-slide-gen 이 잘못 부름 (description 충돌).
→ Phase 2.3 round 2 — slack-daily-report description 에 "NOT for 슬라이드/PPT (→ image-slide-gen)" 추가.
→ Phase 3 round 2 — "보고서 보내" 호출 → 이번엔 slack-daily-report 정확. 그러나 출력 양식이 깨짐 (한글 정렬).
→ Phase 2.5 round 2 — reference.md 에 한글 align 패턴 추가.
→ Phase 3 round 3 — 출력 OK. PASS.
```

---

## Failure modes

- **Phase 1 JTBD 모호**: ideate skill 또는 사용자와 대화로 좁히기 전엔 Phase 2 진행 X
- **Phase 2 트리거 충돌 무시**: Phase 3 에서 다른 스킬이 부르게 됨. 충돌 검사를 skip 하면 안 됨
- **Phase 3 skip**: 가장 흔한 실수. 만들고 등록만 하면 배포 후 첫 실 호출에서 발견. 항상 즉시 호출 1-2회
- **Phase 4 validate FAIL 무시**: ERROR 는 통과 X. WARN 만 통과
- **managed-skills.yaml merge 실패**: rebase 시도 → 충돌 시 사용자에게 수동 sync 안내

## Related

- 결정: `~/workspace/decisions/2026-05-01-skill-lifecycle-mandatory-entry-point.md`
- 검증 자세히: `../validation.md`
- type 분류: `../classification.md`
- spec 전문: `../spec.md`
- 템플릿: `../templates.md`
- 트리거 테스트: `../testing-guide.md`
- 이터레이션 (Phase 5): `cookbook/refine.md`
- 카탈로그 등재만: `cookbook/add.md`
- 배포: `cookbook/publish.md`
- GitHub 백업: `cookbook/push.md`
