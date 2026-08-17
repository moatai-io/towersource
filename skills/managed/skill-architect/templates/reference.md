# Template: Reference

배경지식 / 컨벤션 / 가이드라인을 제공하는 스킬. 직접적인 행동 지시보다는 *AI 가 다른 작업 중 참조*하기 위한 정보.

## 언제 쓰나

- 도메인 지식 (예: "한국식 컨설팅 슬라이드 톤", "OpenAI Responses API 사용 패턴")
- 팀 컨벤션 (예: "Tower 코드 스타일", "DECISIONS.md 형식")
- 자주 헷갈리는 사실 모음 (예: "타입스크립트 모듈 해석 규칙")

## 형식

```markdown
---
name: my-reference
description: <한 문장 도메인 요약>. Use when working with <area>, before <action>, or when "<phrase 1>", "<phrase 2>". NOT for: executing <X> (→ <task-skill>).
version: 0.1.0
tags: [reference]
disable-model-invocation: true   # AI 가 자율로 부르지 않고, 다른 스킬/명시 호출에서만
---

# Reference Title

## 핵심 사실 (가장 자주 잊는 것 위주)
- 사실 1
- 사실 2

## 패턴 모음
### 패턴 A — 언제 / 어떻게
...

### 패턴 B — 언제 / 어떻게
...

## 함정 (자주 틀리는 것)
1. ...
2. ...

## 더 깊은 reference
- `<file>.md` — 케이스 스터디
- 외부: <doc URL>
```

## 권장

- **`disable-model-invocation: true`** — reference 스킬은 자동 트리거 X. 다른 스킬이 `Read` 또는 명시 호출로만 참조.
- **TOC 추가** — 100줄 이상이면 § 헤더로 색인.
- **본문 ≤ 500 줄** — 더 길면 `<section>.md` 로 분리 (lazy load).

## 함께 보기

- AI 가 자율로 부르도록 하려면 → `task.md`
- 행동을 수반하면 → `task.md` + reference 분리
