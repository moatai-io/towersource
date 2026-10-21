import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessionReviewHash, assertSessionReview } from './session-review.mjs';
test('review binds session, HEAD, candidate content and scope', () => {
 const repo=mkdtempSync(join(tmpdir(),'session-review-'));
 const git=args=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
 try {
 git(['init']); git(['-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','initial']);
 writeFileSync(join(repo,'a.txt'),'one');
 const summary={sessionId:'one',repos:[{repo,candidates:[{rel:'a.txt'}]}],bashObservations:[{repo,conflicts:['a.txt']}]};
 const hash=sessionReviewHash(summary); assert.doesNotThrow(()=>assertSessionReview(summary,hash));
 writeFileSync(join(repo,'a.txt'),'two'); assert.throws(()=>assertSessionReview(summary,hash));
 writeFileSync(join(repo,'a.txt'),'one'); assert.throws(()=>assertSessionReview({...summary,sessionId:'other'},hash));
 git(['-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','next']); assert.throws(()=>assertSessionReview(summary,hash));
 } finally {rmSync(repo,{recursive:true,force:true});}
});
