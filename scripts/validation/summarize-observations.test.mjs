import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './summarize-observations.mjs';
test('separates plan cohorts, counts failures, deduplicates runs and ignores incomplete records', () => {
 const e = (runId, planHash, status, durationMs) => JSON.stringify({ runId, planHash, status, durationMs, checkId: 'check' });
 const result = summarize([e('one','a','passed',10),e('one','a','passed',10),e('two','a','failed',100),e('three','b','execution-error',5),'broken','{}'].join('\n'));
 assert.equal(result.invalidRecords,2); assert.equal(result.groups.length,2);
 assert.deepEqual([result.groups[0].runs,result.groups[0].passed,result.groups[0].failed,result.groups[0].p95Ms],[2,1,1,100]);
});
