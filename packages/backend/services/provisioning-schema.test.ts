import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {compareProvisioningMigrationSets,provisioningSchemaStatus,type ProvisioningMigrationFile} from './provisioning-schema.js';
const exec=promisify(execFile);
const file=(name:string,content='select 1;'):ProvisioningMigrationFile=>({name,content:Buffer.from(content)});
const A=file('001_initial.sql'),B=file('002_next.sql'),both=[A,B];
const rows=[{version:'001_initial',name:A.name},{version:'002_next',name:B.name}];
describe('provisioning schema exact inventories',()=>{
 it('sorts exact basenames and matches the signed root hashing algorithm',()=>{
  const status=compareProvisioningMigrationSets([B,A],[]),h=createHash('sha256');
  for(const f of both){h.update(f.name);h.update('\0');h.update(f.content);h.update('\0');}
  expect(status).toEqual({applied:[],pending:[A.name,B.name],migrationSetHash:h.digest('hex')});
 });
 it('preserves pending exact version and permits no numeric-prefix fallback',()=>{
  expect(compareProvisioningMigrationSets(both,[rows[0]]).pending).toEqual([B.name]);
  expect(()=>compareProvisioningMigrationSets(both,[{version:'001',name:A.name}])).toThrow('history_mismatch');
  expect(()=>compareProvisioningMigrationSets(both,[{version:'001_initial',name:'001.sql'}])).toThrow('history_mismatch');
 });
 it('rejects a changed SQL body with the same basename',()=>{
  expect(()=>compareProvisioningMigrationSets([file(A.name,'select 2;'),B],rows,both)).toThrow('schema_set_changed');
 });
 it('rejects renamed/added/removed files and requires fully applied baseline',()=>{
  expect(()=>compareProvisioningMigrationSets([A,file('003_new.sql')],rows,both)).toThrow('schema_set_changed');
  expect(()=>compareProvisioningMigrationSets([A],[],both)).toThrow('schema_set_changed');
  expect(()=>compareProvisioningMigrationSets(both,[rows[0]],both)).toThrow('schema_pending');
  expect(compareProvisioningMigrationSets([B,A],rows,[B,A]).pending).toEqual([]);
 });
 it('rejects foreign, duplicate, inconsistent and gapped history',()=>{
  for(const history of [[{version:'foreign',name:'foreign.sql'}],[rows[0],rows[0]],[{version:'002_next',name:A.name}],[rows[1]]])expect(()=>compareProvisioningMigrationSets(both,history)).toThrow();
 });
 it('rejects empty, duplicate, traversal, oversize and nonbytes inventories',()=>{
  for(const inventory of [[],[A,A],[file('../bad.sql')],[file('bad.sql', 'x'.repeat(1024*1024+1))],[{name:'bad.sql',content:'not-bytes'} as unknown as ProvisioningMigrationFile]])expect(()=>compareProvisioningMigrationSets(inventory,[])).toThrow();
 });
 it('pins all authentication fields without empty-password ambient fallback',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'provisioning-schema-config-'));
  let captured:pg.PoolConfig & {sslnegotiation:string;replication:string}|undefined;
  const mock=vi.spyOn(pg.Pool.prototype,'connect').mockImplementation(function(this:pg.Pool){captured=(this as unknown as {options:typeof captured}).options;return Promise.reject(Error('provider-detail-must-not-escape'));} as never);
  try{
   await writeFile(path.join(directory,A.name),A.content);
   await expect(provisioningSchemaStatus('postgres://explicit_reader@127.0.0.1:5439/fixture',directory)).rejects.toThrow('provisioning_schema_status_unavailable');
   expect(captured?.host).toBe('127.0.0.1');expect(captured?.port).toBe(5439);expect(captured?.user).toBe('explicit_reader');expect(captured?.database).toBe('fixture');
   expect(typeof captured?.password).toBe('function');expect(await (captured!.password as ()=>string)()).toBe('');
   expect(captured?.ssl).toBe(false);expect(captured?.options).toContain('default_transaction_read_only=on');expect(captured?.sslnegotiation).toBe('postgres');expect(captured?.replication).toBe('false');
  }finally{mock.mockRestore();await rm(directory,{recursive:true,force:true});}
 });
 it('requires an explicit complete DSN without ambient/query-string fallback',async()=>{
  for(const dsn of ['', 'postgres:///fixture','postgres://127.0.0.1/fixture','postgres://fixture@127.0.0.1/','postgres://fixture@127.0.0.1/fixture?host=elsewhere','postgres://fixture@127.0.0.1/fixture?options=unsafe'])await expect(provisioningSchemaStatus(dsn,'/not-used')).rejects.toThrow('database_url_invalid');
 });
});

// Opt-in only. The suite creates its own disposable loopback container and never
// accepts a caller-provided DB URL, credentials, shared container or live target.
it.skipIf(process.env.TOWER_PROVISIONING_SCHEMA_DISPOSABLE_TEST!=='1')('native read-only schema preflight on self-created disposable PostgreSQL',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'provisioning-schema-test-'));
 let container:string|undefined,admin:pg.Pool|undefined;
 try{
  const candidate=path.join(root,'candidate'),baseline=path.join(root,'baseline');
  await mkdir(candidate);await mkdir(baseline);
  for(const f of both){await writeFile(path.join(candidate,f.name),f.content);await writeFile(path.join(baseline,f.name),f.content);}
  container=(await exec('docker',['run','--detach','--rm','--publish','127.0.0.1::5432','--env','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'],{timeout:30000})).stdout.trim();
  let ready=false;for(let n=0;n<60;n++){try{await exec('docker',['exec',container,'pg_isready','-U','postgres'],{timeout:3000});ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}
  expect(ready).toBe(true);
  const address=(await exec('docker',['port',container,'5432/tcp'])).stdout.trim();expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
  const port=Number(address.split(':')[1]);
  admin=new pg.Pool({host:'127.0.0.1',port,user:'postgres',password:'',database:'postgres',ssl:false,options:'',connectionTimeoutMillis:3000});
  await admin.query('create role schema_reader login nosuperuser nocreatedb nocreaterole noinherit');
  const dsn=`postgres://schema_reader@127.0.0.1:${port}/postgres`;
  const fresh=await provisioningSchemaStatus(dsn,candidate);expect(fresh.applied).toEqual([]);expect(fresh.pending).toEqual([A.name,B.name]);
  // Fresh preflight does not create the migration ledger or any user relation.
  const untouched=await admin.query("select count(*)::int n from pg_catalog.pg_class c join pg_catalog.pg_namespace n on c.relnamespace=n.oid where n.nspname='public'");expect(untouched.rows[0].n).toBe(0);
  await expect(provisioningSchemaStatus(dsn,candidate,baseline)).rejects.toThrow('schema_pending');
  await admin.query('create schema existing; create table existing.customer_data(id integer)');
  await expect(provisioningSchemaStatus(dsn,candidate)).rejects.toThrow('nonfresh_database');
  await admin.query('drop table existing.customer_data; drop schema existing; create table public._migrations(version text,name text); grant select on public._migrations to schema_reader; create table public.customer_data(id integer)');
  await expect(provisioningSchemaStatus(dsn,candidate)).rejects.toThrow('nonfresh_database');
  await admin.query('drop table public.customer_data');
  expect((await provisioningSchemaStatus(dsn,candidate)).pending).toEqual([A.name,B.name]);
  await admin.query('insert into public._migrations values($1,$2)',[rows[0].version,rows[0].name]);
  expect((await provisioningSchemaStatus(dsn,candidate)).pending).toEqual([B.name]);
  await admin.query('insert into public._migrations values($1,$2)',[rows[1].version,rows[1].name]);
  expect((await provisioningSchemaStatus(dsn,candidate,baseline)).pending).toEqual([]);
  await writeFile(path.join(candidate,A.name),'select 42;');
  await expect(provisioningSchemaStatus(dsn,candidate,baseline)).rejects.toThrow('schema_set_changed');
  await writeFile(path.join(candidate,A.name),A.content);
  await admin.query("update public._migrations set version='001' where name=$1",[A.name]);
  await expect(provisioningSchemaStatus(dsn,candidate)).rejects.toThrow('history_mismatch');
  await admin.query('update public._migrations set version=$1 where name=$2',[rows[0].version,A.name]);
  await admin.query('insert into public._migrations values($1,$2)',['foreign','foreign.sql']);
  await expect(provisioningSchemaStatus(dsn,candidate)).rejects.toThrow('history_mismatch');
  await admin.query("delete from public._migrations where version='foreign'");
  // Reader cannot mutate; verifier uses repeatable-read READ ONLY and closes pool.
  const readers=await admin.query("select count(*)::int n from pg_catalog.pg_stat_activity where application_name='tower-provisioning-schema-readonly'");expect(readers.rows[0].n).toBe(0);
  await writeFile(path.join(root,'outside.sql'),'select 9;');await rm(path.join(candidate,A.name));await symlink(path.join(root,'outside.sql'),path.join(candidate,A.name));
  await expect(provisioningSchemaStatus(dsn,candidate)).rejects.toThrow('status_unavailable');
 }finally{
  if(admin)await admin.end();if(container)await exec('docker',['rm','--force',container],{timeout:10000});await rm(root,{recursive:true,force:true});
 }
},90000);
