import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildDownloadCommand, isManagedDownloadCommand, latestDownloadProgress } from './download-contract.js';
import { DOWNLOAD_SCRIPT } from './download-script.js';
// Deterministic network fixture inside Python: real filesystem, simulated urllib response.
const fixture = String.raw`
import io,urllib.request,socket,sys,json
cfg=json.loads(sys.argv[1]); mode=sys.argv[2]
socket.getaddrinfo=lambda *a,**k:[(2,1,6,'',(('127.0.0.1' if mode=='private' else '8.8.8.8'),443))]
if mode=='disk':
 import shutil
 shutil.disk_usage=lambda path:type('Usage',(),{'free':0})()
if mode=='retry':
 import time
 time.sleep=lambda seconds:None
class Sock:
 def settimeout(self,t): pass
class Response:
 def __init__(self,req):
  offset=int(req.headers.get('Range','bytes=0-')[6:-1]); self.status=206 if req.headers.get('Range') else 200
  if mode=='ignore': self.status=200
  self.headers={'ETag':'"v1"','Content-Length':str(6-offset),'Content-Range':'bytes %d-5/6'%offset}
  if mode in ('no_validator','overlap_changed'): self.headers.pop('ETag')
  if mode=='changed': self.headers['ETag']='"v2"'
  if mode=='bad_range': self.headers['Content-Range']='bytes 0-5/6'
  self.buf=io.BytesIO((b'xbcdef' if mode=='overlap_changed' else b'abcdef')[offset:]); self.fp=type('FP',(),{'raw':type('Raw',(),{'_sock':Sock()})()})()
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def read1(self,n):
  if mode=='stall': raise TimeoutError()
  return self.buf.read(n)
class Opener:
 calls=0
 def open(self,req,timeout):
  self.calls+=1
  if mode=='retry' and self.calls==1: raise TimeoutError()
  if mode=='headers': raise TimeoutError()
  if mode=='http':
   import urllib.error
   raise urllib.error.HTTPError(req.full_url,403,'Forbidden',{},None)
  return Response(req)
urllib.request.build_opener=lambda *a:Opener()
exec(SCRIPT)
`;
function run(mode = 'normal', resume = false, extra: Record<string, unknown> = {}) {
 const dir=mkdtempSync(join(tmpdir(),'tower-download-test-'));
 const config={url:'https://dataset.example/data',destination:'data',connectTimeoutSec:1,idleTimeoutSec:1,maxAttempts:1,...extra};
 if(resume) {
   writeFileSync(join(dir,'data.part'),'abc');
   writeFileSync(join(dir,'data.download.json'),JSON.stringify({sourceFingerprint:createHash('sha256').update(config.url).digest('hex'),validator:mode.includes('validator') || mode==='overlap_changed' ? null : '"v1"',totalBytes:6,...extra}));
 }
 const result=spawnSync('python3',['-c',fixture.replace('exec(SCRIPT)',`exec(${JSON.stringify(DOWNLOAD_SCRIPT)})`),JSON.stringify(config),mode],{cwd:dir,encoding:'utf8',timeout:10000});
 try {return {status:result.status, progress:latestDownloadProgress(result.stdout), data:existsSync(join(dir,'data'))?readFileSync(join(dir,'data'),'utf8'):undefined, partial:existsSync(join(dir,'data.part'))?readFileSync(join(dir,'data.part'),'utf8'):undefined, lock:existsSync(join(dir,'data.download.lock'))};}
 finally {rmSync(dir,{recursive:true,force:true});}
}
describe('managed download',()=>{
 it('validates public URL and destination; exact command cannot include extra shell',()=>{
  const cmd=buildDownloadCommand({url:'https://dataset.example/data',destination:'sources/data'});
  expect(isManagedDownloadCommand(cmd)).toBe(true);
  expect(isManagedDownloadCommand(cmd+'; sleep 10000')).toBe(false);
  for(const destination of ['../x','/x','.','a/../x']) expect(()=>buildDownloadCommand({url:'https://dataset.example/data',destination})).toThrow();
  for(const url of ['http://example.com/x','https://u:p@example.com/x','https://example.com/x?token=secret']) expect(()=>buildDownloadCommand({url,destination:'x'})).toThrow();
 });
 it('downloads and verifies checksum before finalizing',()=>{
  const r=run('normal',false,{sha256:createHash('sha256').update('abcdef').digest('hex')});
  expect(r.status).toBe(0);expect(r.data).toBe('abcdef');expect(r.progress).toMatchObject({phase:'completed',checksumVerified:true,bytesWritten:6});expect(r.lock).toBe(false);
 });
 it('resumes with matching 206 and validator',()=>{expect(run('normal',true).data).toBe('abcdef');});
 it.each([['ignore','RANGE_MISMATCH'],['bad_range','RANGE_MISMATCH'],['changed','REMOTE_CHANGED']])('blocks %s without appending', (mode,code)=>{
  const r=run(mode,true);expect(r.progress?.errorCode).toBe(code);expect(r.partial).toBe('abc');expect(r.status).toBe(1);
 });
 it.each([['stall','BODY_STALLED'],['headers','CONNECT_OR_HEADERS_TIMEOUT'],['http','HTTP_403']])('distinguishes %s failure',(mode,code)=>{expect(run(mode).progress?.errorCode).toBe(code);});
 it('preserves partial data on checksum mismatch',()=>{const r=run('normal',false,{sha256:'0'.repeat(64)});expect(r.progress?.errorCode).toBe('CHECKSUM_MISMATCH');expect(r.partial).toBe('abcdef');expect(r.data).toBeUndefined();});
 it('rejects mismatched expected size before writing',()=>{expect(run('normal',false,{expectedBytes:8}).progress?.errorCode).toBe('SIZE_MISMATCH');});
 it('retries a transient connection failure within policy',()=>{const r=run('retry',false,{maxAttempts:2});expect(r.status).toBe(0);expect(r.progress?.attempt).toBe(2);});
 it('blocks disk exhaustion before writing',()=>{expect(run('disk').progress?.errorCode).toBe('DISK_FULL');});
 it('blocks private network destinations',()=>{expect(run('private').progress?.errorCode).toBe('UNSAFE_URL');});
 it('resumes without validator only with manifest size and checksum',()=>{
  const md5=createHash('md5').update('abcdef').digest('hex');
  const r=run('no_validator',true,{expectedBytes:6,md5});
  expect(r.status).toBe(0);expect(r.data).toBe('abcdef');expect(r.progress).toMatchObject({resumeMethod:'overlap_and_checksum',checksumAlgorithm:'md5',checksumVerified:true});
 });
 it('blocks validator-free resume without checksum',()=>{const r=run('no_validator',true);expect(r.progress?.errorCode).toBe('RESUME_CHECKSUM_REQUIRED');expect(r.partial).toBe('abc');});
 it('does not append when overlap differs',()=>{const r=run('overlap_changed',true,{expectedBytes:6,md5:createHash('md5').update('abcdef').digest('hex')});expect(r.progress?.errorCode).toBe('RESUME_OVERLAP_MISMATCH');expect(r.partial).toBe('abc');});
 it('does not finalize a validator-free resume with wrong manifest checksum',()=>{const r=run('no_validator',true,{expectedBytes:6,md5:'0'.repeat(32)});expect(r.progress?.errorCode).toBe('CHECKSUM_MISMATCH');expect(r.data).toBeUndefined();});
 it('validates checksum inputs',()=>{expect(()=>buildDownloadCommand({url:'https://example.com/data',destination:'data',md5:'x'})).toThrow('INVALID_MD5');expect(()=>buildDownloadCommand({url:'https://example.com/data',destination:'data',md5:'0'.repeat(32),sha256:'0'.repeat(64)})).toThrow('SUPPLY_ONE_CHECKSUM');});
 it('skips incomplete progress lines',()=>{expect(latestDownloadProgress('TOWER_DOWNLOAD_PROGRESS {')).toBeUndefined();});
});

describe('real urllib HTTP loopback fixture (test-only public URL guard override)', () => {
 it('streams a real socket, resumes and finalizes without truncation', async () => {
  const { createServer }=await import('node:http'); const { spawn }=await import('node:child_process');
  const server=createServer((req,res)=>{
   const offset=req.headers.range?Number(req.headers.range.slice(6,-1)):0;
   res.writeHead(offset?206:200,{'etag':'"v1"','content-length':6-offset,...(offset?{'content-range':`bytes ${offset}-5/6`}:{})});
   res.write(Buffer.from('abcdef').subarray(offset,offset+1));setTimeout(()=>res.end(Buffer.from('abcdef').subarray(offset+1)),20);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const dir=mkdtempSync(join(tmpdir(),'tower-download-http-'));
  const address=server.address() as {port:number};
  const cfg={url:`http://127.0.0.1:${address.port}/data`,destination:'data',connectTimeoutSec:1,idleTimeoutSec:1,maxAttempts:1};
  writeFileSync(join(dir,'data.part'),'abc');
  writeFileSync(join(dir,'data.download.json'),JSON.stringify({sourceFingerprint:createHash('sha256').update(cfg.url).digest('hex'),validator:'"v1"',totalBytes:6}));
  // Override just the public-network restriction for loopback; the production tool rejects HTTP.
  const script=DOWNLOAD_SCRIPT.replace('lockfd=None\ntry:', 'validate_url=lambda url:url\nsocket.getaddrinfo=resolve\nlockfd=None\ntry:');
  try {
   const result=await new Promise<{code:number|null,output:string}>(r=>{const p=spawn('python3',['-c',script,JSON.stringify(cfg)],{cwd:dir});let output='';p.stdout.on('data',d=>output+=d);p.on('close',code=>r({code,output}));});
   expect(result.code).toBe(0);expect(readFileSync(join(dir,'data'),'utf8')).toBe('abcdef');expect(latestDownloadProgress(result.output)?.phase).toBe('completed');
  } finally { await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true}); }
 });
});

describe('strict provider nullable checksums', () => {
 it('accepts official MD5 with null SHA-256 without fake hashes', () => {
  const command = buildDownloadCommand({url:'https://example.com/data',destination:'data',md5:'1'.repeat(32),sha256:null} as any);
  expect(isManagedDownloadCommand(command)).toBe(true);
  expect(command).not.toContain('"sha256":null');
 });
 it('does not turn two real hashes into a valid request', () => {
  expect(() => buildDownloadCommand({url:'https://example.com/data',destination:'data',md5:'1'.repeat(32),sha256:'2'.repeat(64)})).toThrow('SUPPLY_ONE_CHECKSUM');
 });
});
