/** Complete one-tenant operator launcher; no ambient credentials or dotenv sourcing. */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { z } from 'zod';
import { prepareProvisionPlan, FEEDBACK_SCHEMA_SHA256, type ProvisionEvidence } from './provision-plan.js';
import { fileBackupAndSourceVerifier, pgCentralAdapter, provisionFeedback } from './provision-apply.js';
import { sshConfigSchema, sshCustomerTransport } from './provision-ssh.js';
import { hashSchema, hostSchema, safePath, readConfig, verifyLocalHost, verifyManifest, productionChecks,
  type LocalChecks, type CommandRunner } from './provision-runtime.js';
import { privateDirectory, readPrivate, refuse, sha } from './provision-files.js';

const pgSchema=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('socket'),host:safePath,port:z.number().int().min(1).max(65535),database:z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),user:z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),socketOwnerUid:z.number().int().nonnegative(),passwordFile:safePath.optional()}).strict(),
  z.object({mode:z.literal('tls'),host:hostSchema,port:z.number().int().min(1).max(65535),database:z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),user:z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),passwordFile:safePath,caFile:safePath}).strict(),
]);
export const launcherConfigSchema=z.object({version:z.literal(1),revision:z.string().regex(/^[a-f0-9]{40}$/),manifestPath:safePath,
  centralHost:hostSchema,customerHost:hostSchema,customerUid:z.number().int().nonnegative(),envPath:safePath,origin:z.string().url(),
  tenant:z.object({id:z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),titlePrefix:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/),label:z.string().regex(/^customer:[a-z0-9][a-z0-9-]{0,62}$/)}).strict(),
  pg:pgSchema,ssh:sshConfigSchema,secretDirectory:safePath,backupFile:safePath,sourceSql:safePath,
  reviewedSchemaFingerprint:hashSchema,reviewedBackupSha256:hashSchema,
}).strict();
export type LauncherConfig=z.infer<typeof launcherConfigSchema>;
export const reviewedPackageSchema=z.object({version:z.literal(1),configHash:hashSchema,planHash:hashSchema,evidenceHash:hashSchema,
  schemaFingerprint:hashSchema,backupSha256:hashSchema,reviewHash:hashSchema,evidence:z.unknown()}).strict();

export async function connectApprovedPg(config:LauncherConfig['pg'],checks:LocalChecks=productionChecks):Promise<Client>{
  const p=pgSchema.parse(config);let password='';let ssl: false | {rejectUnauthorized:true;ca:string}=false;
  if(p.mode==='socket'){
    checks.ancestors(p.host);const socket=path.join(p.host,`.s.PGSQL.${p.port}`);
    const s=fs.lstatSync(socket);if(!s.isSocket()||s.uid!==p.socketOwnerUid)refuse();
    if(p.passwordFile){checks.ancestors(path.dirname(p.passwordFile));password=readPrivate(p.passwordFile).toString();if(!password||/[\r\n\0]/.test(password))refuse();}
  }else{
    for(const f of [p.passwordFile,p.caFile])checks.ancestors(path.dirname(f));
    password=readPrivate(p.passwordFile).toString();if(!password || /[\r\n\0]/.test(password))refuse();
    ssl={rejectUnauthorized:true,ca:readPrivate(p.caFile).toString()};
  }
  // Password callback prevents both PGPASSWORD and implicit pgpass lookup.
  const db=new Client({host:p.host,port:p.port,database:p.database,user:p.user,password:async()=>password,ssl,
    application_name:'tower-feedback-provision',connectionTimeoutMillis:8000,statement_timeout:10000,
    options:'-c search_path=public -c default_transaction_read_only=on'});
  db.on('error',()=>{});
  try{await db.connect();return db;}catch{await db.end().catch(()=>{});return refuse();}
}
export async function runProvisionLauncher(configPath:string,args:string[]=[],options:{runner?:CommandRunner;checks?:LocalChecks}={}){
  const checks=options.checks??productionChecks;let db:Client|undefined;
  try{
    const raw=readConfig(configPath,checks);const c=launcherConfigSchema.parse(JSON.parse(raw.toString()));const configHash=sha(raw);
    const planMode=args.length===0 || (args.length===1 && args[0]==='--dry-run');
    const dryResume=args.length===2 && args[0]==='--review';
    const apply=args.length===5 && args[0]==='--apply' && args[1]==='--review' && args[3]==='--approve';
    if(!planMode&&!dryResume&&!apply)refuse();
    (checks.host??verifyLocalHost)(c.centralHost);verifyManifest(c.manifestPath,c.revision,checks);
    // Receiver must be in the same exact-revision closure layout, not an arbitrary executable.
    if(!/^\/nix\/store\/[A-Za-z0-9._+-]+\/lib\/tower\/dist\/backend\/packages\/backend\/services\/feedback-intake\/provision-receiver-cli\.js$/.test(c.ssh.receiver)
      || !/^\/nix\/store\/[A-Za-z0-9._+-]+\/bin\/node$/.test(c.ssh.node))refuse();
    privateDirectory(c.secretDirectory);checks.ancestors(c.secretDirectory);
    db=await connectApprovedPg(c.pg,checks);
    const central=pgCentralAdapter(db,()=>{(checks.host??verifyLocalHost)(c.centralHost);return c.centralHost;});
    const customer=sshCustomerTransport(c.ssh,options.runner,checks);
    const verifier=fileBackupAndSourceVerifier(c.backupFile,c.sourceSql);
    const deps={central,customer,secretDirectory:c.secretDirectory,verifyBackupAndSource:verifier,checkAncestors:checks.ancestors};
    if(planMode){
      const b=await verifier();const a=await central.inspect(c.tenant.id);const s=await customer.inspect();
      if(a.host!==c.centralHost||a.database!==c.pg.database||a.role!==c.pg.user||a.tenant
        ||a.schemaFingerprint!==c.reviewedSchemaFingerprint||b.backupSha256!==c.reviewedBackupSha256||b.sourceSha256!==FEEDBACK_SCHEMA_SHA256
        ||s.host!==c.customerHost||s.uid!==c.customerUid||s.envPath!==c.envPath||!s.empty)refuse();
      const evidence:ProvisionEvidence={version:1,revision:c.revision,
        central:{expectedHost:c.centralHost,observedHost:a.host,expectedDatabase:c.pg.database,observedDatabase:a.database,expectedRole:c.pg.user,observedRole:a.role,origin:c.origin},
        customer:{expectedHost:c.customerHost,observedHost:s.host,expectedBackendUid:c.customerUid,observedBackendUid:s.uid,envPath:c.envPath},tenant:c.tenant,
        schema:{sourceSha256:b.sourceSha256,liveDefinitionMatches:true,tables:['feedback_tenants','feedback_receipts'],backupVerified:true},
        env:{contentSha256:s.hash,regularSingleLink:true,canonicalNoSymlinks:true,mode:'0600',ownerUid:s.uid,parentTrusted:true,
          keys:['TOWER_FEEDBACK_CLIENT_TOKEN','TOWER_FEEDBACK_CLIENT_ENABLED','TOWER_FEEDBACK_INTAKE_ORIGIN'].map(name=>({name:name as any,count:0,matchesIntended:false}))},
        enrollment:{tenantExists:false,tenantMatchesIntended:false,sameTokenConfirmedInMemory:false,customerConfigured:false,receiptPhase:'none'}};
      const p=prepareProvisionPlan(evidence);
      const packet={version:1 as const,configHash,planHash:p.planHash,evidenceHash:p.evidenceHash,schemaFingerprint:a.schemaFingerprint,backupSha256:b.backupSha256,evidence};
      return {...packet,reviewHash:sha(JSON.stringify(packet))};
    }
    const reviewPath=apply?args[2]:args[1];const packet=reviewedPackageSchema.parse(JSON.parse(readConfig(reviewPath,checks).toString()));
    const {reviewHash,...body}=packet;
    if(packet.configHash!==configHash||sha(JSON.stringify(body))!==reviewHash || (apply&&args[4]!==reviewHash))refuse();
    const evidence=packet.evidence as ProvisionEvidence;const p=prepareProvisionPlan(evidence);
    if(p.target.revision!==c.revision||p.target.central.host!==c.centralHost||p.target.central.database!==c.pg.database
      ||p.target.central.role!==c.pg.user||p.target.central.origin!==new URL(c.origin).origin
      ||p.target.customer.host!==c.customerHost||p.target.customer.uid!==c.customerUid||p.target.customer.envPath!==c.envPath
      ||JSON.stringify(p.target.tenant)!==JSON.stringify(c.tenant)||packet.schemaFingerprint!==c.reviewedSchemaFingerprint||packet.backupSha256!==c.reviewedBackupSha256)refuse();
    if(apply)await db.query('SET default_transaction_read_only=off');
    const result=await provisionFeedback(evidence,{planHash:packet.planHash,evidenceHash:packet.evidenceHash,
      schemaFingerprint:packet.schemaFingerprint,backupSha256:packet.backupSha256},deps,
      apply?['--apply','--approve-plan',packet.planHash,'--approve-evidence',packet.evidenceHash]:[]);
    return {reviewHash,...result};
  }catch{refuse();}finally{await db?.end().catch(()=>{});}
}
