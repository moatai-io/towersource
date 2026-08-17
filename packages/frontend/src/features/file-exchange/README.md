# File Exchange UI

`내 업무 > 파일`의 저장소 전환, typed drag payload, inspect→confirm→execute 흐름을 소유한다.

## Public API

- `<FileExchangeSurface onOpenPersonalItem />`
- `FILE_EXCHANGE_DRAG_TYPE`
- `encodeExchangeDrag()` / `decodeExchangeDrag()`
- `transferFile()`

## 경계

- `ChallengeTimelinePanel`, `InputBox`, 채널, Project 화면은 host/drop target일 뿐 source×destination 정책을 판단하지 않는다.
- raw host path나 파일 본문을 drag payload에 넣지 않는다.
- 모바일은 drag 대신 동일한 전달 action menu를 사용한다.
- 저장소 내부 rename/delete는 각 저장소 화면이 소유한다.
