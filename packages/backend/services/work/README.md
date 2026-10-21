# Work services

Owns canonical Work Ledger persistence, operational health, and work activity projections.

## Public API
- `upsertWorkLedgerRecord(input)` — inserts or updates one canonical work run/source record.
- `listWorkLedgerRecords(args)` — lists canonical records with project and owner context.
- `getWorkLedgerHealth(windowHours)` — reports TodoWrite write freshness, fallback coverage, and completed snapshot rate.
- `getChallengeTimeline(params)` — combines canonical records with legacy TodoWrite message snapshots into Project → Challenge timeline rows.

- `parseWorkReportBlock(content)` — 최종 답변의 독립된 `Work Summary:` 제목 블록(legacy `업무보고:` 포함)을 해석한다.
- `indexWorkReportMessage(input)` / `indexWorkReportMessageUpdate(messageId, content)` — 저장/수정된 assistant 메시지에서 업무 요약을 색인한다. [message-store](../message-store.ts)의 호출은 비동기이며 실패를 로그로 남긴다. 메시지 저장 성공만으로 색인 성공을 단정하지 않는다.

## Notes
- `work_ledger_records` is canonical for new runs. Persisted TodoWrite messages remain a compatibility fallback and backfill source.
- Workstream grouping prefers TodoWrite v3 fields: `work.workstreamKey` for identity and `work.workstreamTitle` for display.
- Legacy TodoWrite v2 data remains readable: `work.epic` falls back to workstream identity/title, then `work.title`, then session name.
- `work.runTitle` / legacy `work.title` describe the specific run; they should not be used as the long-lived grouping key when workstream metadata exists.
- Top-level `backlog` and `questions` can be parsed from snapshots for future detail views, but are not mixed into the main timeline rows yet.
- Legacy fallback time is based on `messages.created_at`, i.e. when a TodoWrite snapshot was persisted, not guaranteed wall-clock labor duration.
- `packages/backend/scripts/backfill-todowrite-work-ledger.ts` is dry-run by default. `--apply` is an explicit mutating operation.
- Health status degrades when recent metadata has no canonical rows, canonical writes lag messages by over 30 minutes, or completed snapshot rate falls below 50% with enough samples.

## 검증 진입점

[업무 요약 파서·색인 테스트](work-report-ledger.test.ts)와 [Work Ledger 테스트](work-ledger.test.ts)를 읽는다. 일반 완료 기록은 TodoWrite 호출이 필수 조건이 아니다. Work Summary 문구를 문장 중간에 넣는 것과 파서가 인식하는 독립 제목 블록은 다르다. 운영 DB 색인·My Work UI 노출은 별도 검증한다.
