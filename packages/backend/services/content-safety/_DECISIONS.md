# Decisions

- 바이너리 파일 자체를 금지하지 않고 LLM-visible 텍스트 속 불투명 payload만 제거한다.
- 원본 파일은 건드리지 않으며 placeholder에 MIME·길이·짧은 해시를 남긴다.
- read 시점과 저장·재수화 시점에 같은 sanitizer를 적용해 신규 및 과거 컨텍스트를 함께 방어한다.
- 8KB 미만 문자열은 코드·fixture 오탐을 줄이기 위해 그대로 둔다.
