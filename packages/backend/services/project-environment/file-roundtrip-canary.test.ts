import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runFileRoundtripCanary, type FileCanaryPort } from './file-roundtrip-canary.js';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true}); });
async function fixture() {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'file-canary-test-'));roots.push(root);
 const port: FileCanaryPort = {
  execute: async command => { const r=await exec('/bin/sh',['-c',command],{cwd:root,timeout:5000});return {exitCode:0,stdout:r.stdout}; },
  read: file => fs.readFile(path.join(root,file),'utf8'),
 };
 return {root,port};
}
it('creates, compares both hashes, updates and cleans only owned scratch',async()=>{
 const {root,port}=await fixture();await fs.writeFile(path.join(root,'keep.txt'),'keep');
 const r=await runFileRoundtripCanary(port);
 expect(r).toMatchObject({status:'PASS',cleanup:'verified',checks:['exclusive-create','api-first-hash','api-updated-hash']});
 expect(await fs.readdir(root)).toEqual(['keep.txt']);expect(r.unverified).toContain('browser');
});
it('fails first mismatched API read and still cleans',async()=>{
 const {root,port}=await fixture();port.read=async()=> 'wrong';
 expect(await runFileRoundtripCanary(port)).toMatchObject({status:'FAIL',failure:'read-first',cleanup:'verified'});
 expect(await fs.readdir(root)).toEqual([]);
});
it('detects stale API content after update',async()=>{
 const {port}=await fixture();const read=port.read;let saved='';port.read=async f=>saved || (saved=await read(f));
 expect(await runFileRoundtripCanary(port)).toMatchObject({status:'FAIL',failure:'read-updated',cleanup:'verified'});
});
it('fails auth/read errors without exposing raw errors',async()=>{
 const {port}=await fixture();port.read=async()=>{throw Error('sensitive-provider-detail');};
 const r=await runFileRoundtripCanary(port);expect(r.status).toBe('FAIL');expect(JSON.stringify(r)).not.toContain('sensitive');
});
it('does not retry or delete after ambiguous create response',async()=>{
 const {root,port}=await fixture();const execute=port.execute;
 port.execute=vi.fn(async command=>{await execute(command);throw Error('response-lost');});
 const r=await runFileRoundtripCanary(port);expect(r).toMatchObject({status:'FAIL',cleanup:'unverified',failure:'create'});
 expect(port.execute).toHaveBeenCalledTimes(1);expect(await fs.readdir(root)).toEqual([r.scratch]);
});
it('refuses cleanup if owner marker changes',async()=>{
 const {root,port}=await fixture();const read=port.read;port.read=async file=>{
  await fs.writeFile(path.join(root,path.dirname(file),'owner'),'changed');return read(file);
 };
 const r=await runFileRoundtripCanary(port);expect(r).toMatchObject({status:'FAIL',failure:'cleanup',cleanup:'unverified'});
 expect(await fs.readdir(root)).toEqual([r.scratch]);
});
it('does not recursively delete unexpected scratch children',async()=>{
 const {root,port}=await fixture();const read=port.read;port.read=async file=>{
  await fs.writeFile(path.join(root,path.dirname(file),'keep.txt'),'untouched');return read(file);
 };
 const r=await runFileRoundtripCanary(port);expect(r).toMatchObject({status:'FAIL',failure:'cleanup'});
 expect(await fs.readFile(path.join(root,r.scratch,'keep.txt'),'utf8')).toBe('untouched');
});
it('fails nonzero execution even with plausible stdout',async()=>{
 const execute=vi.fn(async()=>({exitCode:1,stdout:'ok'}));
 expect(await runFileRoundtripCanary({execute,read:async()=>''})).toMatchObject({status:'FAIL',failure:'create'});
 expect(execute).toHaveBeenCalledTimes(1);
});
