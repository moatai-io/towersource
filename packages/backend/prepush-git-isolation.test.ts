import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
it('archive ceiling rejects parent repository but permits an explicit nested fixture repository',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'prepush-ceiling-'));
 try{
  const archive=path.join(root,'archive'),fixture=path.join(archive,'fixture');mkdirSync(fixture,{recursive:true});
  const env={...process.env};for(const k of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CEILING_DIRECTORIES'])delete env[k];
  const git=(cwd:string,args:string[],extra={})=>spawnSync('git',args,{cwd,env:{...env,...extra},encoding:'utf8'});
  expect(git(root,['init','--quiet']).status).toBe(0);
  expect(git(fixture,['rev-parse','--show-toplevel']).status).toBe(0);
  expect(git(fixture,['rev-parse','--show-toplevel'],{GIT_CEILING_DIRECTORIES:archive}).status).not.toBe(0);
  expect(git(fixture,['init','--quiet']).status).toBe(0);
  expect(git(fixture,['rev-parse','--show-toplevel'],{GIT_CEILING_DIRECTORIES:archive}).stdout.trim()).toBe(fixture);
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('verifier fingerprints and applies archive discovery isolation',()=>{
 const s=readFileSync('scripts/git/pre-push-verified-state','utf8');expect(s).toContain('gitDiscovery=snapshot-ceiling-v1');expect(s).toContain('export GIT_CEILING_DIRECTORIES="$snapshot"');expect(s).toContain('unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE');
});
