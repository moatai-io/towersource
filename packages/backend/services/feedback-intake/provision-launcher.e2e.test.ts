import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { schemaFingerprint } from './provision-apply.js';
import { prepareProvisionPlan, FEEDBACK_SCHEMA_SHA256, type ProvisionEvidence } from './provision-plan.js';
import { sha, managedValues } from './provision-files.js';
import { tokenDigest } from './contract.js';

const fixture=new URL('./provision-subprocess.fixture.ts',import.meta.url).pathname;
describe.skipIf(process.env.FEEDBACK_DISPOSABLE_PG_TEST!=='1')('launcher to subprocess receiver and disposable PG end-to-end',()=>{
  let root:string;let pool:Pool;let review:any;let envPath:string;let original:Buffer;
  const bin=process.env.FEEDBACK_TEST_PG_BIN??'/usr/lib/postgresql/18/bin';
  const run=(args:string[]=[])=>spawnSync(process.execPath,['--import','tsx',fixture,'launcher',root,...args],
    {env:{PATH:'/usr/bin:/bin',FEEDBACK_SUBPROCESS_FIXTURE:'1',PGPASSWORD:'ambient-must-not-be-used',UNRELATED_SECRET:'must-not-inherit'},encoding:'utf8',timeout:30000});
  beforeAll(async()=>{
    fs.mkdirSync('work',{recursive:true});root=fs.mkdtempSync(path.resolve('work/feedback-launcher-fixture-'));fs.chmodSync(root,0o700);
    fs.writeFileSync(path.join(root,'TEST-ONLY'),'disposable');
    for(const dir of ['socket','secrets','backups'])fs.mkdirSync(path.join(root,dir),{mode:0o700});
    execFileSync(path.join(bin,'initdb'),['-D',path.join(root,'data'),'--auth=trust','--no-locale','--encoding=UTF8'],{stdio:'pipe'});
    execFileSync(path.join(bin,'pg_ctl'),['-D',path.join(root,'data'),'-l',path.join(root,'pg.log'),'-o',`-h '' -k ${path.join(root,'socket')} -p 55441`,'-w','start'],{stdio:'pipe'});
    pool=new Pool({host:path.join(root,'socket'),port:55441,database:'postgres',max:2});
    const sql=fs.readFileSync(new URL('./schema.sql',import.meta.url));await pool.query(sql.toString());
    const uid=process.geteuid!();const role=(await pool.query('SELECT current_user AS role')).rows[0].role;
    envPath=path.join(root,'.env');original=Buffer.from('UNRELATED="preserved bytes"\n');
    fs.writeFileSync(envPath,original,{mode:0o600});fs.writeFileSync(path.join(root,'schema.sql'),sql,{mode:0o600});
    fs.writeFileSync(path.join(root,'db.dump'),'synthetic backup receipt',{mode:0o600});
    fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({sourceRev:'a'.repeat(40)}),{mode:0o600});
    for(const f of ['known_hosts','identity'])fs.writeFileSync(path.join(root,f),'synthetic transport fixture',{mode:0o600});
    const e:ProvisionEvidence={version:1,revision:'a'.repeat(40),central:{expectedHost:'central.example.com',observedHost:'central.example.com',expectedDatabase:'postgres',observedDatabase:'postgres',expectedRole:role,observedRole:role,origin:'https://feedback.example.com'},
      customer:{expectedHost:os.hostname(),observedHost:os.hostname(),expectedBackendUid:uid,observedBackendUid:uid,envPath},
      tenant:{id:'customer-a',titlePrefix:'Customer A',label:'customer:customer-a'},schema:{sourceSha256:FEEDBACK_SCHEMA_SHA256,liveDefinitionMatches:true,tables:['feedback_tenants','feedback_receipts'],backupVerified:true},
      env:{contentSha256:sha(original),regularSingleLink:true,canonicalNoSymlinks:true,mode:'0600',ownerUid:uid,parentTrusted:true,keys:['TOWER_FEEDBACK_CLIENT_TOKEN','TOWER_FEEDBACK_CLIENT_ENABLED','TOWER_FEEDBACK_INTAKE_ORIGIN'].map(name=>({name:name as any,count:0,matchesIntended:false}))},enrollment:{tenantExists:false,tenantMatchesIntended:false,sameTokenConfirmedInMemory:false,customerConfigured:false,receiptPhase:'none'}};
    const p=prepareProvisionPlan(e);
    const binding={version:1,revision:e.revision,manifestPath:path.join(root,'manifest.json'),host:os.hostname(),uid,envPath,backupDir:path.join(root,'backups'),planHash:p.planHash,preimage:sha(original),origin:e.central.origin};
    const bindingRaw=JSON.stringify(binding);fs.writeFileSync(path.join(root,'receiver.json'),bindingRaw,{mode:0o600});
    const c={version:1,revision:e.revision,manifestPath:path.join(root,'manifest.json'),centralHost:'central.example.com',customerHost:os.hostname(),customerUid:uid,envPath,origin:e.central.origin,tenant:e.tenant,
      pg:{mode:'socket',host:path.join(root,'socket'),port:55441,database:'postgres',user:role,socketOwnerUid:uid},
      ssh:{target:'backend@customer.example.com',knownHosts:path.join(root,'known_hosts'),identityFile:path.join(root,'identity'),node:'/nix/store/fixture-node/bin/node',receiver:'/nix/store/fixture-app/lib/tower/dist/backend/packages/backend/services/feedback-intake/provision-receiver-cli.js',bindingPath:path.join(root,'receiver.json'),bindingHash:sha(bindingRaw)},
      secretDirectory:path.join(root,'secrets'),backupFile:path.join(root,'db.dump'),sourceSql:path.join(root,'schema.sql'),reviewedSchemaFingerprint:await schemaFingerprint(pool),reviewedBackupSha256:sha('synthetic backup receipt')};
    fs.writeFileSync(path.join(root,'launcher.json'),JSON.stringify(c),{mode:0o600});
  },30000);
  afterAll(async()=>{await pool?.end();if(root){try{execFileSync(path.join(bin,'pg_ctl'),['-D',path.join(root,'data'),'-m','immediate','-w','stop'],{stdio:'pipe'});}finally{fs.rmSync(root,{recursive:true,force:true});}}});
  it('dry-run subprocess inspects receiver+PG without modifying enrollment files or rows',async()=>{
    const r=run();expect(r.stderr).toBe('');expect(r.status).toBe(0);review=JSON.parse(r.stdout);
    expect(review.reviewHash).toMatch(/^[a-f0-9]{64}$/);expect(fs.readdirSync(path.join(root,'secrets'))).toEqual([]);
    expect(fs.readdirSync(path.join(root,'backups'))).toEqual([]);expect(fs.readFileSync(envPath).equals(original)).toBe(true);
    expect((await pool.query('SELECT count(*) FROM feedback_tenants')).rows[0].count).toBe('0');
    fs.writeFileSync(path.join(root,'review.json'),JSON.stringify(review),{mode:0o600});
  });
  it('refuses wrong approval, then applies through real stdin receiver and PG',async()=>{
    const r0=run(['--apply','--review',path.join(root,'review.json'),'--approve','0'.repeat(64)]);expect(r0.status).toBe(1);expect(r0.stdout).toBe('');
    const r=run(['--apply','--review',path.join(root,'review.json'),'--approve',review.reviewHash]);
    expect(r.stderr).toBe('');expect(r.status).toBe(0);expect(JSON.parse(r.stdout).phase).toBe('customer-configured');
    const bytes=fs.readFileSync(envPath);expect(bytes.subarray(0,original.length).equals(original)).toBe(true);
    const token=managedValues(bytes).get('TOWER_FEEDBACK_CLIENT_TOKEN')!;
    expect(r.stdout.includes(token)).toBe(false);
    const rows=(await pool.query('SELECT token_hash FROM feedback_tenants')).rows;
    expect(rows.length).toBe(1);expect(rows[0].token_hash===tokenDigest(token)).toBe(true);
  });
  it('restarts launcher process and reconciles without rewriting or rotating',async()=>{
    const inode=fs.statSync(envPath).ino;const hash=sha(fs.readFileSync(envPath));
    const dry=run(['--review',path.join(root,'review.json')]);expect(dry.status).toBe(0);expect(JSON.parse(dry.stdout).next).toBe('complete');
    const r=run(['--apply','--review',path.join(root,'review.json'),'--approve',review.reviewHash]);expect(r.status).toBe(0);
    expect(fs.statSync(envPath).ino).toBe(inode);expect(sha(fs.readFileSync(envPath))).toBe(hash);
    expect((await pool.query('SELECT count(*) FROM feedback_tenants')).rows[0].count).toBe('1');
  });
  it('refuses changed receiver binding and prints only fixed error',()=>{
    fs.appendFileSync(path.join(root,'receiver.json'),' ');
    const r=run(['--review',path.join(root,'review.json')]);expect(r.status).toBe(1);expect(r.stdout).toBe('');expect(r.stderr).toBe('feedback_fixture_refused\n');
  });
});
