import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSessionCandidates } from './session-selection.mjs';
const summary = () => ({ repos: [{ candidates: [{ rel: 'a.ts' }, { rel: 'old.ts' }], untouchedDirty: [{ rel: 'other.ts' }] }] });
test('old recorded file changed by another task can be left untouched', () => {
 const source = summary(); const narrowed = selectSessionCandidates(source, ['a.ts']);
 assert.deepEqual(narrowed.repos[0].candidates, [{ rel: 'a.ts' }]);
 assert.equal(source.repos[0].candidates.length, 2);
 assert.deepEqual(narrowed.repos[0].untouchedDirty.map(x=>x.rel), ['old.ts','other.ts']);
});
test('does not promote unrelated or unrecorded paths into ownership', () => {
 for (const p of ['other.ts','missing.ts','../a.ts','/a.ts','./a.ts','a//b','']) assert.throws(()=>selectSessionCandidates(summary(),[p]));
});
test('deduplicates and preserves ordinary mode', () => {
 const s=summary(); assert.equal(selectSessionCandidates(s,[]),s);
 assert.equal(selectSessionCandidates(s,['a.ts','a.ts']).repos[0].candidates.length,1);
});
test('rejects ambiguous multi-repository selection', () => {
 const s=summary();s.repos.push(s.repos[0]); assert.throws(()=>selectSessionCandidates(s,['a.ts']));
});
