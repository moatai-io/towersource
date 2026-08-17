# Project Files API

인증된 사용자의 Project 파일 탐색과 core mutation HTTP 경계를 소유한다.

## Public API
- `project-files-router.ts`의 Express Router
- 기존 `/directories`, `/files/tree|read|exists|write|create|mkdir|delete|rename|copy|search` 계약
- notes index, knowledge graph, reveal 탐색 계약

## 경계
- Project ACL과 role별 write 판정은 `services/pm/project-access.ts`가 정본이다.
- 실제 파일 연산은 `services/workspace/`가 소유한다.
- upload, inline edit, ZIP, Office/PDF/CAD preview와 streaming은 아직 legacy `api.ts`에 남는다.
- URL, status, response shape를 변경하지 않는다.
