# /skill-architect refine — 실 사용 경험을 반영하여 스킬 개선

`create` cookbook 의 Phase 5 — 만든 스킬을 며칠~몇 주 사용한 후 발견되는 미세 조정. **"한 번에 잘 만들어지고, 반복으로 다듬어진다" 의 반복 부분.**

## When this runs

- `/skill-architect refine <name>` 명시 호출
- 사용자가 "이 스킬 좀 이상해", "<skill> 가 자꾸 다른 걸 부른다" 등 불편 호소 시
- audit 에서 description / 트리거 / 본문 문제 발견 시
- 새로운 사용 시나리오 추가하고 싶을 때

## Arguments

```
/skill-architect refine <name>              # 인터랙티브 — 단계별 사용자 확인
/skill-architect refine <name> --observed   # 사용자가 관찰한 문제부터 시작
```

## 흐름 (4 phase)

### Phase R1: Observe — 무엇이 문제인가

사용자에게 묻기:

> "이 스킬에서 무엇이 잘 안 되나요?
> 1. **트리거 부정확** — 호출되어야 할 때 안 부르거나, 다른 게 잘못 부른다
> 2. **결과 부정확** — 호출은 되는데 산출물이 기대와 다르다
> 3. **느림** — 시간이 너무 걸린다 (lazy-load 안 됨, 큰 reference 매번 읽음)
> 4. **새 시나리오** — 잘 작동하지만, 새 케이스 추가하고 싶다
> 5. **정리** — 본문이 너무 길어졌다 (distill 필요)"

### Phase R2: Diagnose — 어디를 고쳐야 하는가

문제 유형별로:

| 증상 | 원인 가능성 | 수정 위치 |
|---|---|---|
| **트리거 부정확** (다른 스킬이 부름) | description 의 "Use when" 키워드 부족, "NOT for" 누락 | frontmatter description |
| **트리거 부정확** (안 부름) | 자연어 키워드 (특히 한국어) 누락 | frontmatter description |
| **결과 부정확** | 본문 instruction 모호, 분기 조건 누락, 예시 부족 | SKILL.md 본문 |
| **느림** | reference 안 분리, scripts 매번 read | reference.md / scripts/ 분리 |
| **새 시나리오** | 본문 패턴 추가 또는 examples/ 추가 | examples/, 본문 |
| **본문 길이** | distill 필요 | `/skill-architect distill <path>` |

### Phase R3: Apply — 수정

수정 내용에 따라 다음 cookbook 위임:
- description / 본문 변경 → 직접 Edit
- reference 분리 / 본문 압축 → `cookbook/distill.md`
- 새 자연어 트리거 추가 → description 만 변경 + cross-grep 재검사 (`cookbook/create.md` 의 Phase 2.4)

### Phase R4: Verify — Smoke test 재실행

`create.md` 의 Phase 3 와 동일한 smoke test:
- 사용자에게 시나리오 1-2개 받기 (이번엔 "예전에 fail 했던 케이스" 도 포함)
- 트리거 테스트 + 작동 테스트
- PASS 안 나오면 R2 로 회귀

PASS 후:
- `cookbook/validate.md` 재실행 (품질 게이트)
- version bump (1.0.0 → 1.0.1) — managed skill이면 `config/skills/managed-skills.yaml`도 동기화
- 이미 배포된 self-hosted server 이 있으면 → "먼저 `/skill-registry-orchestration diff <customer>` 로 영향 확인 후 sync 할까요?" 안내

## 흔한 refinement 패턴 (실 경험 archive)

이 섹션은 실제 reference 가 되도록 누적 — 새 패턴 발견 시 추가.

### 패턴 1: description 트리거 충돌

> 증상: "PPT 만들어" → image-slide-gen 이 부르는데 사실 pptx-edit 가 맞을 때도 있음
> 원인: pptx-edit description 에 "PPT 수정" 만 있고 "PPT 만들어 (기존 수정)" 같은 모호한 표현 누락
> 수정: pptx-edit description 의 "Use when" 에 "기존 PPT 손보기", "고객 PPT 수정" 등 추가 + image-slide-gen 의 "NOT for" 에 "기존 .pptx 편집 (→ pptx-edit)" 추가

### 패턴 2: 본문 instruction 부족

> 증상: 작동은 하는데 매번 다르게 동작 (모델이 휴리스틱으로 채움)
> 원인: SKILL.md 가 What 만 적고 How 가 없음
> 수정: 본문에 단계별 분기 조건 + 실패 시 fallback 추가

### 패턴 3: 외부 의존성 미명시

> 증상: 어떤 환경에선 동작, 어떤 환경에선 ImportError
> 원인: prerequisites (Python 패키지, CLI, API 키) 가 SKILL.md 에 없음
> 수정: SKILL.md 상단에 "Prerequisites" 섹션 추가

### 패턴 4: Reference 안 분리 → 매번 큰 본문 read

> 증상: 스킬 호출이 느려짐 (특히 다른 스킬 트리거 시 SKILL.md 들 가중)
> 원인: SKILL.md 에 detailed reference 까지 다 들어가 있음
> 수정: `cookbook/distill.md` 호출

## 핵심 원칙

- **사용 1 주 미만이면 refine 시기 상조** — 데이터 없음. 그냥 fix 로 처리.
- **description 변경은 보수적으로** — 이미 정착한 트리거를 바꾸면 사용자 학습한 호출 패턴이 깨짐. 추가는 OK, 제거는 신중.
- **version bump 잊지 말 것** — refine 후 1.0.0 → 1.0.1. self-hosted server 의 manifest 가 차이를 감지해야 함.
- **이미 배포된 스킬은 재배포 강요 X** — "재배포할까요?" 묻고 사용자 결정.

## Related

- 신규 작성: `cookbook/create.md` (Phase 1-4)
- 검증: `cookbook/validate.md`
- 압축: `cookbook/distill.md`
- 배포: `cookbook/publish.md`
- testing 패턴: `../testing-guide.md`
