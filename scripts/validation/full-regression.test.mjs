import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRegression } from './full-regression.mjs';
const revision = 'a'.repeat(40);
test('pins full command, records lifecycle and preserves failure', () => {
 const receipts=[]; let call; let time=0;
 const result=runRegression({ root:'/fixture',revision, env:{TOWER_PREPUSH_COMMAND:'true',TOWER_PREPUSH_FORCE_FULL:'1'},spawn:(...args)=>{call=args;return {status:7};},save:(_,r)=>receipts.push(r),now:()=>time+=10 });
 assert.deepEqual(call[1],[revision]);
 assert.equal(call[2].env.TOWER_PREPUSH_COMMAND,'npm run preflight');
 assert.equal(call[2].env.TOWER_PREPUSH_FORCE_FULL,'0');
 assert.deepEqual(receipts.map(r=>r.status),['running','failed']);assert.equal(result.exitCode,7);
});
test('rejects short SHA before side effects; launch failure never passes', () => {
 assert.throws(()=>runRegression({root:'/fixture',revision:'abc',save:()=>{throw Error('unexpected');}}),/40-character/);
 const result=runRegression({root:'/fixture',revision,spawn:()=>{throw Error();},save:()=>{}});
 assert.equal(result.exitCode,1);
});
test('successful verifier completion records passed',()=>{
 const result=runRegression({root:'/fixture',revision,spawn:()=>({status:0}),save:()=>{}});
 assert.equal(result.receipt.status,'passed');
});
