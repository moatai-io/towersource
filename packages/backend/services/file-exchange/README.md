# File Exchange

저장 범위 사이의 파일 전달을 계획하고 실행하며 결과 영수증을 남기는 deep module이다.

## 책임

- typed source/destination reference 검증
- source와 destination provider의 현재 권한 재검증
- snapshot 또는 Project workspace copy 조율
- 충돌 없는 대상 이름 결정
- 실패 시 보상 삭제와 durable receipt 기록

## Public API

- `inspectFileTransfer(actor, intent)`
- `executeFileTransfer(actor, planId, confirmed)`
- `getFileTransferReceipt(actor, receiptId)`

HTTP boundary는 `routes/file-exchange-api.ts`이며, UI와 다른 route는 provider 내부 경로나 host path를 알지 않는다.

## 경계

- 각 저장소 provider가 자기 ACL과 bytes 저장을 소유한다.
- 이 모듈은 저장소 내부 rename/delete 또는 범용 파일 탐색을 소유하지 않는다.
- 현재 mode는 immutable snapshot과 workspace copy뿐이다. live reference와 동기화는 지원하지 않는다.
