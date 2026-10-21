import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readdir} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export interface ProvisioningMigrationFile {name:string;content:Uint8Array;}
export interface ProvisioningMigrationHistory {version:string;name:string;}
export interface ProvisioningSchemaStatus {applied:string[];pending:string[];migrationSetHash:string;}
const basename=/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$/;
const maxFiles=5000,maxFileBytes=1024*1024,maxSetBytes=32*1024*1024;
function inventory(input:readonly ProvisioningMigrationFile[]){
 if(!Array.isArray(input)||input.length===0||input.length>maxFiles)throw Error('provisioning_migration_inventory_invalid');
 let bytes=0;const names=new Set<string>();
 const files=input.map(file=>{
  if(!file||typeof file.name!=='string'||!basename.test(file.name)||file.name==='..sql'||names.has(file.name)||!(file.content instanceof Uint8Array)||file.content.byteLength>maxFileBytes)throw Error('provisioning_migration_inventory_invalid');
  bytes+=file.content.byteLength;if(bytes>maxSetBytes)throw Error('provisioning_migration_inventory_too_large');names.add(file.name);
  return {name:file.name,content:Buffer.from(file.content)};
 }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 const h=createHash('sha256');for(const f of files){h.update(f.name);h.update('\0');h.update(f.content);h.update('\0');}
 return {files,hash:h.digest('hex')};
}
/** Names in DB history cannot prove SQL contents. A signed immutable baseline
 * inventory is required for restart/update; no legacy numeric-prefix matching.
 * applied and pending contain exact .sql basenames, not numeric versions. */
export function compareProvisioningMigrationSets(candidate:readonly ProvisioningMigrationFile[],history:readonly ProvisioningMigrationHistory[],baseline?:readonly ProvisioningMigrationFile[]):ProvisioningSchemaStatus{
 const current=inventory(candidate);
 if(baseline!==undefined){
  const old=inventory(baseline);
  if(old.hash!==current.hash)throw Error('provisioning_schema_set_changed');
 }
 if(!Array.isArray(history)||history.length>maxFiles)throw Error('provisioning_migration_history_invalid');
 const expected=new Map(current.files.map(f=>[f.name,f.name.slice(0,-4)])),seen=new Set<string>();
 for(const row of history){
  if(!row||typeof row.version!=='string'||typeof row.name!=='string'||!expected.has(row.name)||row.version!==expected.get(row.name)||seen.has(row.name))throw Error('provisioning_migration_history_mismatch');
  seen.add(row.name);
 }
 const applied=current.files.filter(f=>seen.has(f.name)).map(f=>f.name),pending=current.files.filter(f=>!seen.has(f.name)).map(f=>f.name);
 // An applied suffix with a missing predecessor is not a trustworthy schema baseline.
 if(pending.length&&applied.some(name=>name>pending[0]))throw Error('provisioning_migration_history_gap');
 if(baseline!==undefined&&pending.length)throw Error('provisioning_schema_pending');
 return {applied,pending,migrationSetHash:current.hash};
}
async function readInventory(directory:string):Promise<ProvisioningMigrationFile[]>{
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('provisioning_migration_directory_invalid');
 const st=await lstat(directory);if(!st.isDirectory()||st.isSymbolicLink())throw Error('provisioning_migration_directory_invalid');
 const names=(await readdir(directory)).filter(n=>n.endsWith('.sql')).sort();
 if(names.length===0||names.length>maxFiles)throw Error('provisioning_migration_inventory_invalid');
 const files:ProvisioningMigrationFile[]=[];let bytes=0;
 for(const name of names){
  if(!basename.test(name))throw Error('provisioning_migration_inventory_invalid');
  const file=await open(path.join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const info=await file.stat();if(!info.isFile()||info.size>maxFileBytes)throw Error('provisioning_migration_file_invalid');
   bytes+=info.size;if(bytes>maxSetBytes)throw Error('provisioning_migration_inventory_too_large');
   const content=await file.readFile();if(content.byteLength!==info.size)throw Error('provisioning_migration_file_changed');
   files.push({name,content});
  }finally{await file.close();}
 }
 return files;
}
function explicitDatabaseConfig(databaseUrl:string):pg.PoolConfig & {sslnegotiation:string;replication:string}{
 let url:URL;try{url=new URL(databaseUrl);}catch{throw Error('provisioning_schema_database_url_invalid');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||url.pathname.length<2||url.hash||[...url.searchParams.keys()].some(k=>k!=='sslmode'))throw Error('provisioning_schema_database_url_invalid');
 const sslmode=url.searchParams.get('sslmode');if(url.searchParams.getAll('sslmode').length>1||(sslmode&&!['disable','require','verify-full'].includes(sslmode)))throw Error('provisioning_schema_database_url_invalid');
 if(url.port&&(!Number.isInteger(Number(url.port))||Number(url.port)<1||Number(url.port)>65535))throw Error('provisioning_schema_database_url_invalid');
 // Every connection field is explicit: PG*, DATABASE_URL and service files cannot
 // supply omitted values. Do not put the DSN in exceptions, logs or status output.
 const password=decodeURIComponent(url.password);
 // pg treats password:'' as missing and otherwise consults PGPASSWORD/.pgpass.
 // A callback is truthy and returns exactly the explicit DSN password, even ''.
 return {host:url.hostname.replace(/^\[|\]$/g,''),port:url.port?Number(url.port):5432,user:decodeURIComponent(url.username),password:()=>password,database:decodeURIComponent(url.pathname.slice(1)),sslnegotiation:'postgres',replication:'false',
  ssl:sslmode&&sslmode!=='disable'?{rejectUnauthorized:true}:false,max:1,connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000,idle_in_transaction_session_timeout:5000,
  application_name:'tower-provisioning-schema-readonly',options:'-c search_path=pg_catalog -c default_transaction_read_only=on'};
}
/** Read-only native preflight. Host verifies the signed immutable closure roots
 * before supplying their .../lib/tower/packages/backend/db/migrations paths.
 * This function never invokes initPg or applies migrations, including on fresh DBs. */
export async function provisioningSchemaStatus(databaseUrl:string,candidateDirectory:string,baselineDirectory?:string):Promise<ProvisioningSchemaStatus>{
 const config=explicitDatabaseConfig(databaseUrl);
 let pool:pg.Pool|undefined;
 try{
  const candidate=await readInventory(candidateDirectory),baseline=baselineDirectory===undefined?undefined:await readInventory(baselineDirectory);
  // Check exact content equality before opening the DB, independent of history.
  if(baseline!==undefined&&inventory(candidate).hash!==inventory(baseline).hash)throw Error('provisioning_schema_set_changed');
  pool=new pg.Pool(config);
  const client=await pool.connect();
  try{
   await client.query('begin isolation level repeatable read read only');
   const objects=await client.query<{schema:string;name:string;kind:string}>("select n.nspname as schema,c.relname as name,c.relkind::text as kind from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind in ('r','p','f','m') order by n.nspname,c.relname limit 10001");
   if(objects.rows.length>10000)throw Error('provisioning_schema_inventory_too_large');
   const migration=objects.rows.find(r=>r.schema==='public'&&r.name==='_migrations');
   let history:ProvisioningMigrationHistory[]=[];
   if(!migration){if(objects.rows.length)throw Error('provisioning_schema_nonfresh_database');}
   else{
    if(migration.kind!=='r')throw Error('provisioning_migration_history_invalid');
    const result=await client.query<ProvisioningMigrationHistory>('select version,name from public._migrations order by version limit 5001');history=result.rows;
    if(history.length===0&&objects.rows.some(r=>r.schema!=='public'||r.name!=='_migrations'))throw Error('provisioning_schema_nonfresh_database');
   }
   const status=compareProvisioningMigrationSets(candidate,history,baseline);
   await client.query('commit');return status;
  }finally{client.release();}
 }catch(error){
  // Domain failures are safe to return. Provider/filesystem errors may contain a
  // DSN or host path, so only return a stable redacted category for those.
  if(error instanceof Error&&/^provisioning_[a-z_]+$/.test(error.message))throw error;
  throw Error('provisioning_schema_status_unavailable');
 }finally{if(pool)await pool.end().catch(()=>{});}
}
