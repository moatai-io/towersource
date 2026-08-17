---
name: pptx-review
description: |
  Vision-driven PPTX review loop — 빌드 결과를 자동으로 진단하고 yaml 수정안을 제안.
  알고리즘 진단(텍스트 overflow risk, 빈 필드, schema 누락) + Vision 평가(색상·정렬·
  한국 컨설팅 톤) 결합. 사람이 매번 "이거 텍스트 넘쳤네" 보고 yaml 고치는 일을 자동화.
  Use when: "PPTX 검수", "슬라이드 리뷰", "이거 잘 만들어졌는지 봐줘", "vision review",
  "PPT 자동 평가", "pptx 진단", "/pptx-review", "한국식 톤 점검", "발표자료 품질 체크".
  Companion to /pptx-template (build), /pptx-edit (modify), /image-slide-gen (generate).
argument-hint: "[path/to/data.yaml or path/to/output.pptx]"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# pptx-review — Vision-driven PPTX Review Loop

빌드된 슬라이드를 **알고리즘 + Claude Vision** 두 단계로 검증하고 수정안 제안.

## 워크플로 (5-Step)

```
입력: yaml 또는 pptx 경로
   ↓
Step 1. (필요시) 빌드 + 렌더 — yaml 만 받았으면 build_from_yaml.py + render_png.py
   ↓
Step 2. Static 진단 — diagnose_static.py 로 알고리즘 잡을 수 있는 이슈
   ↓
Step 3. Vision 평가 — Read 로 PNG 들 (Vision) → 10 dimension 평가
   ↓
Step 4. 종합 리포트 — Static + Vision 결과 머지, 우선순위 정리, yaml 수정 제안
   ↓
Step 5. (사용자 승인 시) 적용 → 재빌드 → 재검증
```

---

## Step 1 — Inputs & Build

입력 가능한 형태:
- (a) **yaml 경로** — 빌드 + 렌더 부터 자동
- (b) **pptx 경로** — 렌더만, yaml 없으면 vision 만 가능
- (c) **이미 PNG 있는 폴더** — render skip

`<dir>/data.yaml` 와 `<dir>/output.pptx` 와 `<dir>/slide-NNN.png` 모두 같은 폴더에 있는 게 표준 (pptx-template 산출물 컨벤션).

빌드 명령:
```bash
uv run --script /workspace/.tower/skills/pptx-template/scripts/build_from_yaml.py \
    --data <dir>/data.yaml --out <dir>/output.pptx
python3 /workspace/.tower/skills/pptx-edit/scripts/render_png.py <dir>/output.pptx
```

---

## Step 2 — Static 진단 (알고리즘)

`scripts/diagnose_static.py <data.yaml>` 실행. 다음을 검사:

| Check | 기준 | 심각도 |
|---|---|---|
| Bullet 길이 | 한 불릿 80자 초과 | warn (overflow risk) |
| KPI value 길이 | value 5자 초과 | warn (자동 축소되지만 단축 권장) |
| Takeaway 길이 | 80자 초과 | warn |
| Insight 길이 | 70자 초과 | warn |
| Title 길이 | 40자 초과 | warn (한 줄 안 들어감) |
| Cover_short headline | 25자 초과 | warn (두 줄 됨) |
| Slide 수 | 20+ 면 toc 권장 | info |
| Chapter 일관성 | section 의 chapter_idx vs meta.chapters | error if mismatch |
| Source 명시 | content 슬라이드에 source 0개 | info (source_default 만 사용 중) |
| Confidential | meta.confidential 미지정 | info (B2B 외부 발표 시 권장) |

출력 형식: JSON 또는 사람-친화 표.

---

## Step 3 — Vision 평가 (현재 세션의 Claude 가 직접)

⚠️ **중요**: 외부 Vision API 호출 X. 별도 모델 X. **현재 세션의 Claude (이 대화의 모델)
가 Read 도구로 PNG 를 직접 받아서** 평가한다. Read 가 이미지 받으면 Claude 가 그걸
멀티모달 입력으로 본다 — 한 번에 외부 호출 없이 끝.

장점:
- 외부 API 키·토큰 비용 추가 X
- 세션 컨텍스트 (yaml + meta + 이전 평가) 유지된 상태에서 평가
- 결과를 바로 yaml 패치 제안으로 연결 가능

각 슬라이드 PNG 를 Read 도구로 열어 **10 dimension** 으로 평가.
[reference.md](reference.md) 의 평가 기준 참조.

**한꺼번에 다 읽지 말 것** — 슬라이드 5장씩 묶어 평가. 다음 묶음으로 넘어가기 전에
간단한 메모로 누적. 같은 슬라이드를 의심되면 두 번 보는 것도 OK (토큰 비용 작음).

평가 dimension (1-5 점):
1. 텍스트 overflow / 박스 넘침
2. 헤더·푸터 chrome 정합성
3. takeaway 강조 효과
4. insight 콜아웃 가독성
5. 색상 일관성 (네이비/오렌지 톤)
6. 한글/영문 폰트 균형
7. 정보 밀도 (비어있음 vs 빽빽함)
8. 한국 컨설팅 톤 적합성
9. 출처 / 페이지 / 비밀등급 표기
10. 챕터 트래커 / 목차 정합성

각 슬라이드별로 점수표 + 발견된 이슈 한 줄.

---

## Step 4 — 종합 리포트

Static + Vision 결과 머지. 우선순위:
- **High** (반드시 수정): 텍스트 잘림, 색상 깨짐, schema 오류
- **Medium** (수정 권장): 톤 어색, takeaway 길이, 정보 밀도
- **Low** (선택적): 디테일 폴리시

각 이슈에 yaml 수정 제안 첨부:
```yaml
# 슬라이드 5 (bullets) — bullet 4 너무 길어서 오버플로 위험
# Before:
- "60+ 검증된 스킬 — 보고서 · 이메일 · 문서 · 견적서 · SMS · 회의록 자동화"
# After:
- "60+ 빌트인 스킬 — 보고서·이메일·문서·SMS·회의록"
```

리포트 산출물 위치: `<dir>/review_report.md` (옵션, 저장 시).

---

## Step 5 — 적용 (사용자 승인 후)

기본은 **human in the loop** — 제안만, 사용자가 "적용해줘" 하면 진행.
빠른 모드: 사용자가 처음부터 "전부 자동 적용" 옵션 선택 시 High/Medium 일괄 적용.

적용:
1. yaml 백업 (`data.yaml.backup`)
2. Edit 으로 yaml 수정
3. 재빌드 (build_from_yaml.py)
4. 재렌더 (render_png.py)
5. 변경된 슬라이드만 다시 Vision 검증
6. 모든 High 이슈 해소 확인 → 완료 보고

---

## Test Pack

| Type | JTBD | Purpose |
|------|------|---------|
| Primary | 키움 15쪽 슬라이드 검증 → 이슈 5+ 발견 → 3개 fix | 핵심 워크플로 |
| Primary | 빈 슬라이드 (필드 누락) → static 진단으로 잡힘 | 알고리즘 정확도 |
| Edge | 한글 폰트 깨진 슬라이드 (□ 박스) → vision 으로 잡힘 | vision 강점 |
| Edge | yaml 없이 .pptx 만 받음 → vision-only mode | 입력 유연성 |
| Regression | 한 번 fix 한 이슈가 다음 빌드에서 재발 안 함 | 사이클 안정성 |

### Success Criteria

- High 이슈 100% 자동 검출 (static + vision)
- yaml 수정 제안의 70% 이상이 사용자 승인
- 사이클 1회당 5분 이내 (15쪽 기준)

---

## v0.2 후보

- 자동 적용 모드 (사람 confirm 없이) 의 안전장치 (rollback)
- 평가 dimension 의 가중치 조정 (사용자별 톤 선호)
- 다른 스킬 결과 검증 (pptx-edit, image-slide-gen) 직접 통합
- review_report.md 를 markdown 으로 저장 → 산출물 폴더 내 영구 추적
