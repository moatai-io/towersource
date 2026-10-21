import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { prepareProvisionPlan, FEEDBACK_SCHEMA_SHA256, type ProvisionEvidence } from './provision-plan.js';
import { provisionFeedback, fileBackupAndSourceVerifier, type CentralAdapter, type ApplyDependencies } from './provision-apply.js';
import { localCustomerAdapter, feedbackSshSpec } from './provision-customer.js';
import { managedValues, sha } from './provision-files.js';
import { tokenDigest } from './contract.js';
let root: string; let envPath: string; let secretDirectory: string; let e: ProvisionEvidence;
let tenant: Awaited<ReturnType<CentralAdapter['inspect']>>['tenant']; let deps: ApplyDependencies;
const uid=process.geteuid!();
const pristine=Buffer.from('# synthetic fixture\nUNRELATED="keep this value"\n');
const fingerprint='f'.repeat(64), backup='b'.repeat(64);
const approval=()=>{const p=prepareProvisionPlan(e);return {planHash:p.planHash,evidenceHash:p.evidenceHash,schemaFingerprint:fingerprint,backupSha256:backup};};
const applyArgs=()=>{const p=prepareProvisionPlan(e);return ['--apply','--approve-plan',p.planHash,'--approve-evidence',p.evidenceHash];};
const run=(args=applyArgs())=>provisionFeedback(e,approval(),deps,args);
beforeEach(()=>{
  fs.mkdirSync('work',{recursive:true});root=fs.mkdtempSync(path.resolve('work/feedback-apply-'));
  fs.chmodSync(root,0o700);secretDirectory=path.join(root,'secrets');fs.mkdirSync(secretDirectory,{mode:0o700});
  const backups=path.join(root,'backups');fs.mkdirSync(backups,{mode:0o700});
  envPath=path.join(root,'.env');fs.writeFileSync(envPath,pristine,{mode:0o600});tenant=null;
  e={version:1,revision:'a'.repeat(40),central:{expectedHost:'central.example.com',observedHost:'central.example.com',expectedDatabase:'tower_chat',observedDatabase:'tower_chat',expectedRole:'tower',observedRole:'tower',origin:'https://feedback.example.com'},
    customer:{expectedHost:'customer.example.com',observedHost:'customer.example.com',expectedBackendUid:uid,observedBackendUid:uid,envPath},
    tenant:{id:'customer-a',titlePrefix:'Customer A',label:'customer:customer-a'},
    schema:{sourceSha256:FEEDBACK_SCHEMA_SHA256,liveDefinitionMatches:true,tables:['feedback_tenants','feedback_receipts'],backupVerified:true},
    env:{contentSha256:sha(pristine),regularSingleLink:true,canonicalNoSymlinks:true,mode:'0600',ownerUid:uid,parentTrusted:true,
      keys:['TOWER_FEEDBACK_CLIENT_TOKEN','TOWER_FEEDBACK_CLIENT_ENABLED','TOWER_FEEDBACK_INTAKE_ORIGIN'].map(name=>({name:name as any,count:0,matchesIntended:false}))},
    enrollment:{tenantExists:false,tenantMatchesIntended:false,sameTokenConfirmedInMemory:false,customerConfigured:false,receiptPhase:'none'}};
  deps={secretDirectory,checkAncestors:()=>{},verifyBackupAndSource:vi.fn(async()=>({backupSha256:backup,sourceSha256:FEEDBACK_SCHEMA_SHA256})),
    central:{inspect:vi.fn(async()=>({host:'central.example.com',database:'tower_chat',role:'tower',schemaFingerprint:fingerprint,tenant})),
      insert:vi.fn(async(t,h)=>{if(tenant)throw new Error('already exists');tenant={tokenHash:h,titlePrefix:t.titlePrefix,label:t.label,active:true};})},
    customer:localCustomerAdapter({host:'customer.example.com',uid,envPath,backupDir:backups,observeIdentity:()=>({host:'customer.example.com',uid}),checkAncestors:()=>{}})};
});
afterEach(()=>{fs.rmSync(root,{recursive:true,force:true});});
describe('narrow feedback apply adapter',()=>{
  it('defaults to directly verified dry-run, creates no token/receipt/env/row',async()=>{
    const r=await run([]);expect(r.mode).toBe('dry-run');expect(fs.readdirSync(secretDirectory)).toEqual([]);
    expect(tenant).toBeNull();expect(fs.readFileSync(envPath).equals(pristine)).toBe(true);
    expect(deps.central.inspect).toHaveBeenCalled();expect(deps.verifyBackupAndSource).toHaveBeenCalled();
  });
  it.each([['--apply'],['--apply','--approve-plan','x'],['--force']])('refuses unapproved apply args',async args=>{
    await expect(run(args)).rejects.toThrow('feedback_provision_apply_refused_or_needs_review');expect(fs.readdirSync(secretDirectory)).toEqual([]);
  });
  it('applies one insert, preserves unrelated bytes, creates private backup and secret-free receipt',async()=>{
    const r=await run();expect(r.mode).toBe('applied');const bytes=fs.readFileSync(envPath);
    expect(bytes.subarray(0,pristine.length).equals(pristine)).toBe(true);
    const token=managedValues(bytes).get('TOWER_FEEDBACK_CLIENT_TOKEN')!;
    expect(Buffer.from(token,'base64url').length).toBe(32);expect(tenant!.tokenHash===tokenDigest(token)).toBe(true);
    const p=approval();const receipt=fs.readFileSync(path.join(secretDirectory,`${p.planHash}.receipt.json`),'utf8');
    expect(receipt.includes(token)).toBe(false);expect(receipt.includes(tenant!.tokenHash)).toBe(false);
    expect(JSON.parse(receipt).phase).toBe('customer-configured');
    expect(fs.readFileSync(path.join(root,'backups',`${p.planHash}.env-before`)).equals(pristine)).toBe(true);
    expect(fs.statSync(envPath).mode&0o777).toBe(0o600);
    const before=fs.statSync(envPath).ino;await run();expect(fs.statSync(envPath).ino).toBe(before);
    expect(deps.central.insert).toHaveBeenCalledTimes(1);
  });
  it('resumes ambiguous DB commit without inserting twice or rotating token',async()=>{
    const original=deps.central.insert;
    deps.central.insert=vi.fn(async(t,h)=>{await original(t,h);throw new Error('synthetic secret provider detail');});
    await expect(run()).rejects.toThrow('feedback_provision_apply_refused_or_needs_review');
    const hash=tenant!.tokenHash;deps.central.insert=vi.fn(async(t,h)=>original(t,h));await run();
    expect(tenant!.tokenHash).toBe(hash);expect(deps.central.insert).not.toHaveBeenCalled();
  });
  it('resumes failed transport with the persisted token',async()=>{
    const append=deps.customer.appendStdin;deps.customer.appendStdin=async()=>{throw new Error('lost transport');};
    await expect(run()).rejects.toThrow();const h=tenant!.tokenHash;
    deps.customer.appendStdin=append;await run();expect(tenant!.tokenHash).toBe(h);expect(deps.central.insert).toHaveBeenCalledTimes(1);
  });
  it('reconciles lost customer ACK without overwriting or appending again',async()=>{
    const append=deps.customer.appendStdin;deps.customer.appendStdin=async input=>{await append(input);throw new Error('lost ACK');};
    await expect(run()).rejects.toThrow();const inode=fs.statSync(envPath).ino;
    deps.customer.appendStdin=vi.fn(append);await run();expect(deps.customer.appendStdin).not.toHaveBeenCalled();expect(fs.statSync(envPath).ino).toBe(inode);
  });
  it('refuses forged evidence booleans when direct schema/identity differ',async()=>{
    deps.central.inspect=async()=>({host:'other.example.com',database:'tower_chat',role:'tower',schemaFingerprint:fingerprint,tenant:null});
    await expect(run()).rejects.toThrow();expect(fs.readdirSync(secretDirectory)).toEqual([]);
  });
  it('refuses backup mismatch, schema drift and stale env before generating token',async()=>{
    deps.verifyBackupAndSource=async()=>({backupSha256:'0'.repeat(64),sourceSha256:FEEDBACK_SCHEMA_SHA256});
    await expect(run()).rejects.toThrow();
    deps.verifyBackupAndSource=async()=>({backupSha256:backup,sourceSha256:FEEDBACK_SCHEMA_SHA256});
    const inspect=deps.central.inspect;deps.central.inspect=async id=>({...await inspect(id),schemaFingerprint:'0'.repeat(64)});
    await expect(run()).rejects.toThrow();deps.central.inspect=inspect;
    fs.appendFileSync(envPath,'OTHER=changed\n');await expect(run()).rejects.toThrow();expect(tenant).toBeNull();
    expect(fs.readdirSync(secretDirectory)).toEqual([]);
  });
  it('rejects an existing matching tenant without this operation receipt',async()=>{
    tenant={tokenHash:'a'.repeat(64),titlePrefix:'Customer A',label:'customer:customer-a',active:true};
    await expect(run()).rejects.toThrow();expect(deps.central.insert).not.toHaveBeenCalled();
  });
  it('refuses missing persisted token instead of reissuing after partial failure',async()=>{
    deps.customer.appendStdin=async()=>{throw new Error('stop');};await expect(run()).rejects.toThrow();
    fs.unlinkSync(path.join(secretDirectory,`${approval().planHash}.token`));
    await expect(run()).rejects.toThrow();expect(deps.central.insert).toHaveBeenCalledTimes(1);
  });
  it('refuses token tampering, receipt tampering and operation lock contention',async()=>{
    fs.mkdirSync(path.join(secretDirectory,'enrollment.lock'));await expect(run()).rejects.toThrow();fs.rmdirSync(path.join(secretDirectory,'enrollment.lock'));
    deps.customer.appendStdin=async()=>{throw new Error('stop');};await expect(run()).rejects.toThrow();
    const p=approval();fs.writeFileSync(path.join(secretDirectory,`${p.planHash}.token`),'z'.repeat(43));await expect(run()).rejects.toThrow();
    const receiptPath=path.join(secretDirectory,`${p.planHash}.receipt.json`);
    const r=JSON.parse(fs.readFileSync(receiptPath,'utf8'));r.approvalHash='0'.repeat(64);fs.writeFileSync(receiptPath,JSON.stringify(r));await expect(run()).rejects.toThrow();
  });
  it.each(['TOWER_FEEDBACK_CLIENT_ENABLED=false\n','export TOWER_FEEDBACK_CLIENT_TOKEN=x\n','UNRELATED=$(command)\n','BAD="multiline\nvalue"\n'])('rejects conflicting/ambiguous dotenv without modification',async text=>{
    fs.writeFileSync(envPath,text);e.env.contentSha256=sha(text);await expect(run()).rejects.toThrow();expect(fs.readFileSync(envPath,'utf8')).toBe(text);expect(tenant).toBeNull();
  });
  it('refuses symlink or readable-by-group env',async()=>{
    fs.chmodSync(envPath,0o640);await expect(run()).rejects.toThrow();fs.chmodSync(envPath,0o600);
    const original=envPath+'.real';fs.renameSync(envPath,original);fs.symlinkSync(original,envPath);await expect(run()).rejects.toThrow();
  });
  it('hashes explicit backup/source files and refuses an insecure backup',async()=>{
    const b=path.join(root,'db-backup'),s=path.join(root,'schema.sql');
    fs.writeFileSync(b,'synthetic-backup',{mode:0o600});fs.writeFileSync(s,'synthetic-schema');
    const verify=fileBackupAndSourceVerifier(b,s);
    expect(await verify()).toEqual({backupSha256:sha('synthetic-backup'),sourceSha256:sha('synthetic-schema')});
    fs.chmodSync(b,0o644);await expect(verify()).rejects.toThrow();
  });
  it('refuses conflicting prior backup without touching customer env',async()=>{
    fs.writeFileSync(path.join(root,'backups',`${approval().planHash}.env-before`),'different',{mode:0o600});
    await expect(run()).rejects.toThrow();expect(fs.readFileSync(envPath).equals(pristine)).toBe(true);
  });
  it('refuses env drift introduced immediately before stdin delivery',async()=>{
    const append=deps.customer.appendStdin;deps.customer.appendStdin=async input=>{
      fs.appendFileSync(envPath,'UNRELATED_SECOND=new\n');await append(input);
    };
    await expect(run()).rejects.toThrow();expect(managedValues(fs.readFileSync(envPath)).size).toBe(0);
  });
  it('fails closed under default unsafe ancestor policy instead of trusting evidence',async()=>{
    deps.checkAncestors=undefined;
    // Shared checkout ancestry is not a secret-safe operator directory.
    // Force an explicit unsafe ancestor in the temporary fixture.
    fs.chmodSync(root,0o777);
    await expect(run()).rejects.toThrow();expect(tenant).toBeNull();
  });
  it('binds customer request identity and transports secrets only in stdin',async()=>{
    const append=deps.customer.appendStdin;deps.customer.appendStdin=async input=>{
      const r=JSON.parse(input.toString());r.host='other.example.com';await append(Buffer.from(JSON.stringify(r)));
    };await expect(run()).rejects.toThrow();expect(fs.readFileSync(envPath).equals(pristine)).toBe(true);
    const spec=feedbackSshSpec('backend@customer.example.com','/etc/tower/known_hosts');
    expect(spec.argv.at(-1)).toBe('/usr/local/libexec/tower-feedback-customer-append');
    expect(spec.argv).toContain('StrictHostKeyChecking=yes');expect(spec.input).toBe('bounded-json-stdin-only');
    expect(()=>feedbackSshSpec('backend@customer.example.com;evil','/etc/known_hosts')).toThrow();
  });
});
