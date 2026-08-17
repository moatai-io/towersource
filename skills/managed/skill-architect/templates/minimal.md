# Template: Minimal

가장 작은 작동하는 스킬. *trigger 만 명확히 정의된* 한 가지 일을 수행.

## 언제 쓰나

- 기능이 한 문장으로 표현됨
- 보조 파일 (scripts/, reference.md) 불필요
- 외부 deps 없음

## 형식

```markdown
---
name: my-skill
description: One-line JTBD. Use when "<phrase 1>", "<phrase 2>", "/my-skill". NOT for: <out-of-scope> (→ <other-skill>).
version: 0.1.0
tags: [task]
---

# My Skill

## When this runs
- <trigger 자연어 변형 1>
- <trigger 자연어 변형 2>
- `/my-skill` 명시 호출

## Steps
1. <action 1>
2. <action 2>
3. <action 3>

## Examples
**Input**: "<user phrase>"
**Output**: <expected behavior>
```

## 안 적합한 경우

- 보조 파일이 1개라도 필요 → `task.md` 또는 `file-writing.md`
- 여러 모드 / 여러 도구 호출 → `multi-agent.md`
- 백그라운드 지식 위주 → `reference.md`
