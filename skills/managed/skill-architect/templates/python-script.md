# Template: Python Script (PEP 723 + uv run --script)

스킬 안 `scripts/*.py` 의 표준 형식. **외부 의존성이 있는 모든 Python 스크립트는 이 패턴 의무.**

근거: `workspace/decisions/2026-05-08-skill-uv-pep723-standard.md`

## 헤더 형식

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
my_script.py — 한 줄 목적.

사용법:
    uv run --script my_script.py <args>
"""

import argparse
from openai import OpenAI
from pptx import Presentation
...
```

## SKILL.md 호출 패턴

```bash
# ✅ 표준 — Project Runtime Box/materialized skill 기준
uv run --script /workspace/.tower/skills/<name>/scripts/my_script.py <args>

# ✅ repo 검증 중이면 source 경로에서 직접
uv run --script skills/managed/<name>/scripts/my_script.py <args>

# ❌ 금지 — 외부 deps가 있는데 시스템 python 의존
python3 /workspace/.tower/skills/<name>/scripts/my_script.py <args>
```

## 의존성 명시 — import 이름 ≠ PyPI 패키지명

자주 헷갈리는 매핑:

| import | PyPI 패키지명 |
|---|---|
| `from PIL import Image` | `pillow` |
| `import yaml` | `pyyaml` |
| `from google import genai` | `google-genai` |
| `from pptx import Presentation` | `python-pptx` |
| `import cv2` | `opencv-python` |
| `from bs4 import BeautifulSoup` | `beautifulsoup4` |
| `import sklearn` | `scikit-learn` |

## 외부 deps 없는 경우 — 헤더 생략 가능

순수 stdlib (`os`, `sys`, `json`, `pathlib`, `argparse`, `subprocess`, ...) 만 쓰면 PEP 723 헤더 생략하고 `python3 <path>.py` 호출 OK. 시스템 python 으로 충분하니까.

판단:
- 외부 import 0개 → 헤더 X, `python3` 호출 OK
- 외부 import 1개라도 → **헤더 필수**, `uv run --script` 의무

## 의존성 추가 / 변경 시

`.py` 의 PEP 723 dependencies 와 SKILL.md 의 호출 패턴이 *함께 갱신*돼야 함. drift 검출은 `/skill-architect validate` (cookbook/validate.md §2.1) 가 자동.

## 왜 이 형식

- **격리** — 매 실행 ephemeral venv. 다른 스킬 / 시스템 python 과 deps 충돌 X
- **속도** — uv 는 pip 대비 10-100배. cold cache 1-2초, warm cache 즉시
- **재현성** — deps 가 스크립트 자체에 박혀있어 버전 명시
- **단일 파일** — `pyproject.toml` 따로 안 만들고 self-contained
- **시스템 오염 X** — `pip install --user` 안 함

## 참고

- 결정 문서: `workspace/decisions/2026-05-08-skill-uv-pep723-standard.md`
- validate audit: `cookbook/validate.md` §2.1
- create 흐름: `cookbook/create.md` §2.5.1
