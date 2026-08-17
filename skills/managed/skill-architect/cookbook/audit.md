# /skill-architect audit — 디렉토리 전체 일괄 검증

Tower-owned managed/operator skill directories 또는 임의 디렉토리의 모든 SKILL.md 를 일괄 validate. 정기 점검·운영 용도. Legacy `legacy provider config home/skills`는 migration/fallback 진단 때만 대상이다.

## When this runs

- `/skill-architect audit` 명시 호출 (전체 점검)
- `/skill-architect audit <path>` (특정 디렉토리)
- selfheal skill 의 일부로 (문서·스킬 정합성 점검)
- schedule 으로 주기 점검 (단기 follow-up)

## Arguments

```
/skill-architect audit                # skills/managed + skills/* 기본 점검
/skill-architect audit <path>         # 지정 디렉토리
/skill-architect audit --catalog      # config/skills/managed-skills.yaml 등재된 스킬만
```

## Steps

### 1. 대상 enumeration

```bash
# 전체 managed/operator source
find skills/managed skills -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null

# managed catalog 등재된 스킬만
yq '.library.skills[].name' config/skills/managed-skills.yaml
```

### 2. 각 스킬에 validate 적용

`cookbook/validate.md` 의 단계를 각 스킬에 반복. 결과를 누적.

### 3. 카탈로그 정합성 cross-check

추가로 검사:
- **디스크 ↔ managed-skills.yaml mismatch**:
  - `skills/managed/<name>/SKILL.md`는 있지만 yaml 미등록 → `unregistered`
  - yaml 에는 있지만 source 파일 누락 → `missing`
- **태그 일관성**:
  - SKILL.md frontmatter 의 tags 와 managed catalog 의 tags 가 일치하는가?

### 4. 결과 보고

```markdown
## Audit: <directory>

### Overview
- **Skills Found**: N (디스크) / M (yaml)
- **Passed**: X
- **Warnings**: Y
- **Failed**: Z
- **Unregistered**: U (디스크에는 있지만 yaml 미등록)
- **Missing**: V (yaml 에는 있지만 디스크 누락)

### Per-Skill Results

| Skill | Status | Errors | Warnings | Catalog |
|-------|--------|--------|----------|---------|
| pptx-edit | PASS | 0 | 1 | OK |
| pptx-template | PASS | 0 | 0 | OK |
| <legacy> | FAIL | 2 | 3 | unregistered |

### Critical Issues
- ...

### Recommendations
- 등록 누락: managed 배포 대상이면 `config/skills/managed-skills.yaml`에 추가; operator-only면 `skills/<name>/` 유지
- 누락 항목: repo source 또는 backup에서 복원
- FAIL 항목: `/skill-architect validate <path> --fix` 시도
```

## Use cases

- **분기마다 한 번**: 운영자가 정기 점검
- **Drift 의심 시**: `scripts/skills/deploy-managed-skills.sh --diff <customer>` 또는 `/skill-registry-orchestration diff <customer>` 후 본 서버 audit
- **신규 운영자 인수**: 전체 카탈로그 상태를 한눈에 파악

## Related

- 단일 스킬: `cookbook/validate.md`
- 카탈로그 등재: `cookbook/add.md`
- 검증 본체: `../validation.md`
