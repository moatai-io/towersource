import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { readCanonicalProjectFileBytes,readCanonicalProjectFileProbe,writeCanonicalProjectText } from './canonical-host-file-adapter.js';
let base:string,root:string;
beforeEach(()=>{base=fs.mkdtempSync(path.join(os.tmpdir(),'alias-read-'));root=path.join(base,'p');fs.mkdirSync(root);fs.mkdirSync(path.join(root,'real'));fs.writeFileSync(path.join(root,'real','file.txt'),'ordinary');fs.writeFileSync(path.join(base,'outside'),'outside');});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(base,{recursive:true,force:true});});
const link=(target:string,name:string)=>fs.symlinkSync(target,path.join(root,name));
it('reads file and directory aliases, chains, absolute internal targets and probes',()=>{
 link('real','folder');link('folder/file.txt','file');link(path.join(root,'file'),'absolute');
 for(const p of ['folder/file.txt','file','absolute'])expect(readCanonicalProjectFileBytes(root,p,100).toString()).toBe('ordinary');
 expect(readCanonicalProjectFileProbe(root,'file',2).toString()).toBe('or');
});
it('permits relative parent traversal only inside the Project',()=>{
 fs.mkdirSync(path.join(root,'other'));link('../real','other/link');expect(readCanonicalProjectFileBytes(root,'other/link/file.txt',100).toString()).toBe('ordinary');
});
it('rejects external targets including links returning inside',()=>{
 fs.symlinkSync(path.join(root,'real'),path.join(base,'back'));link('../back','escape');
 expect(()=>readCanonicalProjectFileBytes(root,'escape/file.txt',100)).toThrow('OUTSIDE_PROJECT');
});
it.each(['.env','.env.production','.git/config','.tower-run-credentials/key','.audit/log','.claude/config','.mcp.json'])('denies protected alias target %s',name=>{
 fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),'protected');link(name,'alias');expect(()=>readCanonicalProjectFileBytes(root,'alias',100)).toThrow('PROTECTED');
});
it('rejects loops and broken links',()=>{link('b','a');link('a','b');link('missing','broken');expect(()=>readCanonicalProjectFileBytes(root,'a',100)).toThrow('LOOP');expect(()=>readCanonicalProjectFileBytes(root,'broken',100)).toThrow();});
it('retains hardlink rejection and strict writes through aliases',()=>{
 link('real/file.txt','alias');fs.linkSync(path.join(root,'real/file.txt'),path.join(root,'hard'));
 expect(()=>readCanonicalProjectFileBytes(root,'alias',100)).toThrow();expect(()=>writeCanonicalProjectText(root,'alias','changed')).toThrow();
 expect(fs.readFileSync(path.join(root,'real/file.txt'),'utf8')).toBe('ordinary');
});
it('fails closed when resolved final file becomes an external link before open',()=>{
 link('real/file.txt','alias');const original=fs.openSync;let changed=false;
 vi.spyOn(fs,'openSync').mockImplementation(((p:fs.PathLike,flags:any,...args:any[])=>{
  if(!changed && String(p).endsWith('/file.txt') && (Number(flags)&fs.constants.O_NOFOLLOW) && !(Number(flags)&fs.constants.O_DIRECTORY)){
   changed=true;fs.unlinkSync(path.join(root,'real/file.txt'));fs.symlinkSync(path.join(base,'outside'),path.join(root,'real/file.txt'));
  }
  return (original as any)(p,flags,...args);
 }) as typeof fs.openSync);
 expect(()=>readCanonicalProjectFileBytes(root,'alias',100)).toThrow();expect(changed).toBe(true);
});
it('fails closed when resolved ancestor is exchanged for an external directory link',()=>{
 link('real/file.txt','alias');const original=fs.openSync;let visits=0;
 vi.spyOn(fs,'openSync').mockImplementation(((p:fs.PathLike,flags:any,...args:any[])=>{
  if(String(p).endsWith('/real') && ++visits===2){fs.renameSync(path.join(root,'real'),path.join(root,'saved'));fs.symlinkSync(base,path.join(root,'real'));}
  return (original as any)(p,flags,...args);
 }) as typeof fs.openSync);
 expect(()=>readCanonicalProjectFileBytes(root,'alias',100)).toThrow();expect(visits).toBe(2);
});
