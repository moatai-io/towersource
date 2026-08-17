# /skill-architect distill — 의미 분석 + 압축

스킬이 부풀어 오르거나 (bloat) description 트리거가 부정확해질 때, 본문을 분석해서 핵심만 남기고 reference 로 분리. **사용 1-2 주 후의 정제** 작업.

## When this runs

- `/skill-architect distill <path>` 명시 호출
- `/skill-architect refine` 워크플로우의 한 단계 (사용 후 관찰 → distill → 재검증)
- audit 에서 "SKILL.md ≥ 500줄" 경고 발견 시
- description 트리거 정확도가 떨어졌을 때 (cross-skill confusion 발생)

## Arguments

```
/skill-architect distill <path>           # 분석만 (Section Map 출력)
/skill-architect distill <path> --validate # + cross-model trigger probes (실제 자연어로 호출 테스트)
/skill-architect distill <path> --apply    # + 권고대로 실제 rewrite
```

## Steps

### 1. Section Map 추출

SKILL.md 의 모든 ## / ### 헤더 + 각 섹션의 줄수 + 첫 줄 요약을 표로:

```
## Section            Lines  Hint
## Usage              25     CLI commands and flags
### For validate      30     ...
## Protocol           150    Full step-by-step
## Validation Rules   80     Spec checklist (move to reference?)
...
```

### 2. 의미 분석

각 섹션을 다음 기준으로 분류:
- **Core trigger** (반드시 SKILL.md 본체) — frontmatter, top-level usage, 1차 protocol
- **Detailed protocol** (본체 또는 reference) — 단계별 자세한 행동
- **Reference / spec** (reference 로 분리 권장) — 체크리스트, API 표, 템플릿
- **Examples** (옵션 — examples/ 디렉토리로 분리) — sample input/output

### 3. (--validate) Cross-model trigger probes

description 의 자연어 트리거를 다른 모델 (Gemini / Codex / Claude) 에게 던져서 어느 스킬을 부르는지 확인:

```bash
for trigger in "<test prompt 1>" "<test prompt 2>"; do
  echo "$trigger" | (claude / gemini / codex CLI)
  → 어느 스킬이 트리거되는지 기록
done
```

→ 의도와 다른 스킬이 부르면 description 보강 필요 (NOT for, 자연어 trigger 추가).

### 4. (--apply) 실제 rewrite

분류 결과를 적용:
- "Reference" 로 분류된 섹션 → `<skill>/reference.md` (또는 새 `reference/`) 로 이동
- "Examples" → `<skill>/examples/` 로 이동
- SKILL.md 본문은 핵심만 유지, reference 는 path 로 lazy-load 안내

이후 `cookbook/validate.md` 자동 실행 (재검증).

### 5. 결과 보고

```markdown
## Distill: <name>

### Before
- SKILL.md: 720 lines
- Trigger accuracy (probes): 60%

### After (--apply)
- SKILL.md: 280 lines
- Reference moved: validation-checklist.md (240 lines), examples/ (200 lines)
- Trigger accuracy (probes): 95% (NOT for 보강 후)

### Recommendations
- description 의 "Use when" 에 "<신규 자연어 키워드>" 추가 권장
- testing pack 신규 작성 권장
```

## When NOT to distill

- 사용 1주 미만 — 사용 패턴 데이터 부족
- < 200 줄 SKILL.md — 압축할 가치 없음
- 트리거 정확도 ≥ 95% — 건드리지 말 것

## Related

- 검증: `cookbook/validate.md`
- 이터레이션: `cookbook/refine.md`
- spec: `../spec.md`
- testing: `../testing-guide.md`
