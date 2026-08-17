# Template: File-Writing

파일을 *생성하거나 수정*하는 스킬. Task 의 특화 형태 — 산출물이 디스크에 남음.

## 언제 쓰나

- 사용자에게 절대경로로 인계할 산출물 만듦 (PDF, PPTX, PNG, MD, ...)
- 코드/문서 생성 또는 수정
- 형식이 정해진 결과물 (예: 견적서, 보고서, 슬라이드)

## 형식

```markdown
---
name: my-file-writer
description: <한 문장 JTBD — 무엇을 어떻게 만드는지>. Use when "<phrase 1>", "<phrase 2>", "/my-file-writer". Triggers on creating/generating <output type>. NOT for: <similar-but-different> (→ <other-skill>).
version: 0.1.0
tags: [task, file-writing]
allowed-tools: Bash, Read, Write, Edit
---

# File Writer Title

## When this runs
- ...

## Inputs
- <필요한 입력 1>
- <필요한 입력 2>

## Execution Plan (사용자에게 먼저 보여주기)

> ⚠️ **file-writing 의무** — 파일 만들기 전에 *계획* 을 짧게 보여주고 사용자 컨펌 받기.
>   "어디에 / 어떤 형식 / 몇 개 / 덮어쓸지" 4가지를 먼저 합의.

```
계획:
- 위치: ~/workspace/projects/<p>/<dir>/<name>.<ext>
- 형식: <markdown | pdf | pptx | png | json | ...>
- 개수: N 파일
- 기존 파일 있으면: <덮어쓰기 | 새 이름 | 사용자 컨펌>
```

## Steps
1. 입력 검증
2. (필요 시) 데이터 변환 / 가공
3. **파일 쓰기** — Write/Edit 도구 또는 스크립트 호출
4. **절대경로 인계** — 산출물 절대경로를 한 줄로 안내 (Tower auto-linker)

## Output path

Do not write user-visible artifacts to `/tmp` or a fixed project-specific path.
If the current project has a visible scaffold, follow the project `AGENTS.md` first.
Use the scaffold only as a broad default: drafts/builds/intermediate files under `work/`, shareable final packages under `final/`, raw inputs/captures/transcripts under `sources/`, logs/audits under `records/`, and reusable procedures/patterns under `knowledge/`.
If the project has an existing stronger convention, follow that project convention instead.

## Output 인계 형식

```
~/workspace/projects/<p>/<dir>/<name>.<ext>
```

각 파일은 단독 줄. 마크다운 링크 `[]()` 로 감싸지 말 것 (404 위험).

## Python scripts/

`scripts/*.py` 가 있으면 → [`python-script.md`](python-script.md) 참조 (PEP 723 + uv run --script 의무).

## Edge cases
- 디렉토리 없음 → mkdir -p 또는 사용자 컨펌
- 같은 이름 파일 존재 → 컨펌 또는 timestamp suffix
- 권한 부족 → 명확히 보고
