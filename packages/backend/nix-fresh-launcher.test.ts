import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {it,expect} from 'vitest';

it('executes fresh and legacy launcher gates without a server or database',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'tower-launch-contract-'));
 try {
  const rev='a'.repeat(40);
  for(const dir of ['lib/tower/dist/backend/packages/backend','share/tower','bin','runtime','data','workspace'])mkdirSync(path.join(root,dir),{recursive:true});
  writeFileSync(path.join(root,'lib/tower/dist/backend/packages/backend/index.js'),'console.log("fixture-started")');
  writeFileSync(path.join(root,'bin/tower-nix-render'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  writeFileSync(path.join(root,'share/tower/release-manifest.json'),JSON.stringify({version:'1.0.0',baseVersion:'1.0.0',sourceRev:rev,gitSha:rev.slice(0,12)}));
  const env:Record<string,string>={PATH:process.env.PATH!,TOWER_APP_ROOT:root,TOWER_RUN_MODE:'nix-production',TOWER_NIX_PRODUCTION_PROFILE:'canary',NODE_ENV:'production',HOST:'127.0.0.1',PORT:'32400',PUBLIC_URL:'http://127.0.0.1:32400',DATABASE_URL:'postgresql://fixture@127.0.0.1:5432/fresh_fixture',JWT_SECRET:'synthetic-fixture-not-a-real-secret',TOWER_NIX_CANARY_MARKER:'fresh_fixture',TOWER_RUNTIME_CWD:path.join(root,'runtime'),TOWER_DATA_DIR:path.join(root,'data'),WORKSPACE_ROOT:path.join(root,'workspace'),DEFAULT_CWD:path.join(root,'workspace'),TOWER_NIX_RECOVERY_MODE:'fresh-install',TOWER_FRESH_INSTALL_ACK:rev,TOWER_FRESH_RECOVERY_POLICY:'stop-and-preserve'};
  const run=(over:Record<string,string>={},action='check')=>spawnSync('bash',['scripts/nix-app/tower-app-start-production',action],{env:{...env,...over},encoding:'utf8'});
  const ok=run();expect(ok.status,ok.stderr).toBe(0);expect(JSON.parse(ok.stdout)).toMatchObject({rollbackReady:false,recoveryMode:'fresh-install'});
  for(const over of [{TOWER_FRESH_INSTALL_ACK:''},{TOWER_FRESH_INSTALL_ACK:'b'.repeat(40)},{TOWER_FRESH_RECOVERY_POLICY:'delete'},{TOWER_HOST_ROLLBACK_ENTRYPOINT:'/some/file'},{TOWER_NIX_RECOVERY_MODE:'unknown'},{TOWER_NIX_PRODUCTION_PROFILE:'authority',HOST:'0.0.0.0',PORT:'32364',PUBLIC_URL:'https://tower.example.com'}])expect(run(over).status).not.toBe(0);
  expect(run({},'run').status).not.toBe(0);
  const started=run({TOWER_NIX_PRODUCTION_ACK:rev},'run');expect(started.status,started.stderr).toBe(0);expect(started.stdout).toContain('fixture-started');
  expect(run({TOWER_NIX_RECOVERY_MODE:'host-rollback'}).status).not.toBe(0);
  const rollback=path.join(root,'rollback.js');writeFileSync(rollback,'// synthetic prior generation');
  const legacy=run({TOWER_NIX_RECOVERY_MODE:'',TOWER_HOST_ROLLBACK_ENTRYPOINT:rollback});expect(legacy.status,legacy.stderr).toBe(0);expect(JSON.parse(legacy.stdout)).toMatchObject({rollbackReady:true,recoveryMode:'host-rollback'});
 } finally {rmSync(root,{recursive:true,force:true});}
});
