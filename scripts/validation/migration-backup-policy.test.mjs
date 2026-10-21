import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { migrationBackupPolicy as policy } from './migration-backup-policy.mjs';
const m={path:'fixture.sql',sql:'fixture'};
const review={sha256:createHash('sha256').update(m.sql).digest('hex'),risk:'non-destructive',reason:'constraint expansion',recovery:'inspect new values before restoring constraint',verify:'check catalog'};
test('unknown/empty/changed/data migrations require full backup',()=>{
 assert.equal(policy([]).backup,'full');assert.equal(policy([m]).backup,'full');
 assert.equal(policy([{...m,sql:'changed'}],{[m.path]:review}).backup,'full');
 assert.equal(policy([m],{[m.path]:{...review,risk:'data-change'}}).backup,'full');
});
test('only complete content-bound reviews permit schema record',()=>{
 assert.equal(policy([m],{[m.path]:review}).backup,'schema-record');
 for(const key of ['reason','recovery','verify'])assert.equal(policy([m],{[m.path]:{...review,[key]:''}}).backup,'full');
 assert.equal(policy([m,{path:'other',sql:'unknown'}],{[m.path]:review}).backup,'full');
});
