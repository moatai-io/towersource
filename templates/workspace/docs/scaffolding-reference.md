# Workspace Scaffolding Reference

이 문서는 새 workspace scaffold에 기본 포함할 문서 세트를 설명합니다.

## 기본 포함 문서

### 루트
- `AGENTS.md`: 항상 필요한 핵심 규칙 + 상세 문서 안내
- `principles.md`: 팀 원칙

### docs/
- `docs/agents-reference.md`: 에이전트가 필요 시 읽는 상세 참고서
- `docs/scaffolding-reference.md`: scaffold 구조와 문서 역할 설명
- `docs/.gitkeep`: 빈 디렉토리 유지용

### decisions/
- `decisions/.template.md`: 결정 문서 템플릿

### .project/
- `.project/decisions/.template.md`: 프로젝트 결정 템플릿
- `.project/state.json`: 시스템 상태 파일

### memory/
- `memory/MEMORY.md`: 프로젝트/워크스페이스 메모리

### notes/
- `notes/.gitkeep`: 임시 메모용

### published/
- `published/.template-version`: scaffold 버전 표기

## 문서 역할 원칙
- `AGENTS.md`는 짧고 안정적인 핵심 규칙만 담습니다.
- 상세 운영/구조/절차는 `docs/` 아래 문서로 분리합니다.
- 에이전트는 필요 시에만 상세 참고 문서를 읽습니다.
- 프로젝트별 구체 규칙은 각 프로젝트의 `AGENTS.md`가 담당합니다.

## 왜 이렇게 나누나
- 항상 로드되는 프롬프트 길이를 줄여 prompt caching에 유리합니다.
- 자주 바뀌는 상세 문서를 분리해 핵심 지침의 안정성을 높입니다.
- 팀/프로젝트별 확장을 쉽게 만듭니다.
