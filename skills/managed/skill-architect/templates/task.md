# Template: Task

명시적 단계가 있는 *작업 실행* 스킬. 가장 흔한 패턴.

## 언제 쓰나

- "X 해줘" 류 사용자 요청을 받아 단계별로 수행
- 결과물이 명확 (메시지 발송, 데이터 조회, 분석 출력 등)
- 외부 도구 호출이 1-2개 정도 (3+ 면 `multi-agent.md` 고려)

## 형식

```markdown
---
name: my-task
description: <한 문장 JTBD>. Use when "<phrase 1>", "<phrase 2>", "/my-task". Triggers on <action verb>. NOT for: <adjacent-but-different> (→ <other-skill>).
version: 0.1.0
tags: [task]
allowed-tools: Bash, Read, Grep    # 필요한 것만
---

# Task Title

## When this runs
- "<자연어 trigger 1>"
- "<자연어 trigger 2>"
- `/my-task` 명시 호출

## Pre-flight
- 필수 환경 변수 / 키 확인
- 필요한 입력 파일 / 인자 검증

## Steps
1. **<단계 1>** — <왜 / 무엇을>
   ```bash
   <명령어 또는 의사 코드>
   ```
2. **<단계 2>**
3. **<단계 3>**

## Output
- 사용자에게 보일 형식 (표 / 차트 / 절대경로 / etc.)

## Output path

If this skill writes files, do not write user-visible artifacts to `/tmp` or a fixed project-specific path.
Follow the current project `AGENTS.md` and scaffold when present. Keep this section short; do not copy the whole scaffold philosophy into each skill.

## Edge cases
- 입력 비어있음 → ...
- 외부 호출 실패 → ...
- 권한 부족 → ...

## Examples
**Input**: "<user phrase>"
**Steps run**: 1, 2, 3
**Output**: ...
```

## 권장

- **`allowed-tools` 명시** — 필요한 것만. AI 가 다른 도구 호출 시도하면 차단.
- **Pre-flight 가드** — 외부 호출 전에 사전 조건 검증. 30초 들여서 명령 돌렸는데 키 없어서 실패하면 사용자 짜증.
- **Edge cases 1-3 개** — 가장 자주 일어날 것만. 모든 케이스 다 다룰 필요 X.
