import { afterEach,describe,it,expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runApprovedCodeCheck,digestCodeManifest} from './bounded-code-check';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(script:string){await fs.mkdir('work/goal-check-tests',{recursive:true});const root=await fs.mkdtemp(path.resolve('work/goal-check-tests/run-'));roots.push(root);await fs.writeFile(path.join(root,'check.cjs'),script);return {root,files:['check.cjs'],executable:process.execPath,args:['check.cjs'],timeoutMs:2000,maxOutputBytes:10000};}
describe('approved real process checker',()=>{
 it('passes actual assertions and produces a manifest digest',async()=>{const spec=await fixture("require('node:assert/strict').equal(2+2,4)");expect(await runApprovedCodeCheck(spec,new AbortController().signal)).toMatchObject({status:'passed',artifactDigest:await digestCodeManifest(spec.root,spec.files)});});
 it('rejects failed assertions',async()=>{const spec=await fixture("require('node:assert/strict').equal(2+2,5)");expect((await runApprovedCodeCheck(spec,new AbortController().signal)).status).toBe('failed');});
 it('does not certify a test that mutates its checked artifacts',async()=>{const spec=await fixture("require('node:fs').appendFileSync('check.cjs','\\n// changed')");expect(await runApprovedCodeCheck(spec,new AbortController().signal)).toMatchObject({status:'inconclusive',reason:'artifact_changed'});});
 it('bounds long-running execution',async()=>{const spec=await fixture('setInterval(()=>{},100)');spec.timeoutMs=100;expect(await runApprovedCodeCheck(spec,new AbortController().signal)).toMatchObject({status:'inconclusive',reason:'timeout'});});
 it('bounds output without returning captured text',async()=>{const spec=await fixture("process.stdout.write('x'.repeat(50000))");spec.maxOutputBytes=100;expect(await runApprovedCodeCheck(spec,new AbortController().signal)).toMatchObject({status:'inconclusive',reason:'output_limit'});});
 it('does not launch a pre-cancelled check',async()=>{const spec=await fixture("throw Error('must not run')");const c=new AbortController();c.abort();expect(await runApprovedCodeCheck(spec,c.signal)).toEqual({status:'inconclusive',reason:'cancelled'});});
 it('rejects traversal and symlinks',async()=>{const spec=await fixture('');await expect(digestCodeManifest(spec.root,['../check.cjs'])).rejects.toThrow('INVALID_CHECK_PATH');await fs.symlink('check.cjs',path.join(spec.root,'link.cjs'));await expect(digestCodeManifest(spec.root,['link.cjs'])).rejects.toThrow('CHECK_SYMLINK_REJECTED');});
});
