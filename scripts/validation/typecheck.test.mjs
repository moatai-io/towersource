import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runTypechecks } from './typecheck.mjs';
test('starts both independent projects and waits for both failures/successes', async () => {
 const children=[];
 const result=runTypechecks({ launch:()=>{const child=new EventEmitter(); children.push(child); return child;}, log:()=>{} });
 assert.equal(children.length,2);
 children[1].emit('exit',0,null); children[0].emit('exit',2,null);
 assert.equal(await result,2);
});
test('launch errors fail without hiding the other result', async () => {
 let calls=0;
 const result=runTypechecks({launch:()=>{calls++;throw Error();},log:()=>{}});
 assert.equal(await result,1); assert.equal(calls,2);
});

test('frontend-only invokes one compiler; invalid project fails before launch', async () => {
 let calls=0;
 const launch=()=>{calls++;const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0,null));return child;};
 assert.equal(await runTypechecks({projects:['frontend'],launch,log:()=>{}}),0);
 assert.equal(calls,1);
 await assert.rejects(runTypechecks({projects:['unknown'],launch,log:()=>{}}));
 assert.equal(calls,1);
});
