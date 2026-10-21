import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { pgCentralAdapter, schemaFingerprint } from './provision-apply.js';
import { tokenDigest } from './contract.js';
// Dedicated disposable PG only. No DATABASE_URL, .env, provider or live target reads.
describe.skipIf(process.env.FEEDBACK_DISPOSABLE_PG_TEST !== '1')('provisioning real PG insert and schema observation',()=>{
  let root:string;let pool:Pool;let baseline:string;
  const bin=process.env.FEEDBACK_TEST_PG_BIN??'/usr/lib/postgresql/18/bin';
  beforeAll(async()=>{
    fs.mkdirSync('work',{recursive:true});root=fs.mkdtempSync(path.resolve('work/feedback-provision-pg-'));fs.mkdirSync(path.join(root,'socket'));
    execFileSync(path.join(bin,'initdb'),['-D',path.join(root,'data'),'--auth=trust','--no-locale','--encoding=UTF8'],{stdio:'pipe'});
    execFileSync(path.join(bin,'pg_ctl'),['-D',path.join(root,'data'),'-l',path.join(root,'pg.log'),'-o',`-h '' -k ${path.join(root,'socket')} -p 55440`,'-w','start'],{stdio:'pipe'});
    pool=new Pool({host:path.join(root,'socket'),port:55440,database:'postgres',max:2});
    await pool.query(fs.readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
    baseline=await schemaFingerprint(pool);
  },30000);
  afterAll(async()=>{
    await pool?.end();if(root){try{execFileSync(path.join(bin,'pg_ctl'),['-D',path.join(root,'data'),'-m','immediate','-w','stop'],{stdio:'pipe'});}finally{fs.rmSync(root,{recursive:true,force:true});}}
  });
  it('inserts a real tenant once with namespaced digest and no raw token stored',async()=>{
    const adapter=pgCentralAdapter(pool,()=> 'central.example.com');
    const t={id:'customer-a',titlePrefix:'Customer A',label:'customer:customer-a'};
    expect((await adapter.inspect(t.id)).tenant).toBeNull();
    await adapter.insert(t,tokenDigest('synthetic-token'));
    const current=await adapter.inspect(t.id);
    expect(current.schemaFingerprint).toBe(baseline);expect(current.database).toBe('postgres');
    expect(current.tenant?.tokenHash===tokenDigest('synthetic-token')).toBe(true);
    await expect(adapter.insert(t,tokenDigest('replacement-token'))).rejects.toMatchObject({code:'23505'});
    expect((await adapter.inspect(t.id)).tenant?.tokenHash===tokenDigest('synthetic-token')).toBe(true);
  });
  it('observes concurrent duplicate attempts as one insert, never an upsert',async()=>{
    const adapter=pgCentralAdapter(pool,()=> 'central.example.com');
    const t={id:'customer-b',titlePrefix:'Customer B',label:'customer:customer-b'};
    const results=await Promise.allSettled([adapter.insert(t,tokenDigest('first')),adapter.insert(t,tokenDigest('second'))]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect((await pool.query('SELECT count(*) FROM feedback_tenants WHERE id=$1',[t.id])).rows[0].count).toBe('1');
  });
  it('detects schema constraint drift without applying any repair',async()=>{
    await pool.query('ALTER TABLE feedback_tenants DROP CONSTRAINT feedback_tenants_label_check');
    expect(await schemaFingerprint(pool)).not.toBe(baseline);
  });
});
