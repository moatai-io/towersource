import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { FEEDBACK_SCHEMA_SHA256, prepareProvisionPlan, type ProvisionEvidence } from './provision-plan.js';
const evidence = (): ProvisionEvidence => ({ version: 1, revision: 'a'.repeat(40),
  central: { expectedHost:'central.example.com', observedHost:'central.example.com', expectedDatabase:'tower', observedDatabase:'tower', expectedRole:'tower', observedRole:'tower', origin:'https://feedback.example.com' },
  customer: { expectedHost:'customer.example.com', observedHost:'customer.example.com', expectedBackendUid:1000, observedBackendUid:1000, envPath:'/srv/tower/.env' },
  tenant: { id:'customer-a', titlePrefix:'Customer A', label:'customer:customer-a' },
  schema: { sourceSha256: FEEDBACK_SCHEMA_SHA256, liveDefinitionMatches:true, tables:['feedback_tenants','feedback_receipts'], backupVerified:true },
  env: { contentSha256:'b'.repeat(64), regularSingleLink:true, canonicalNoSymlinks:true, mode:'0600', ownerUid:1000, parentTrusted:true,
    keys:['TOWER_FEEDBACK_CLIENT_TOKEN','TOWER_FEEDBACK_CLIENT_ENABLED','TOWER_FEEDBACK_INTAKE_ORIGIN'].map(name=>({name:name as any,count:0,matchesIntended:false})) },
  enrollment: { tenantExists:false, tenantMatchesIntended:false, sameTokenConfirmedInMemory:false, customerConfigured:false, receiptPhase:'none' } });
describe('bounded feedback enrollment planner',()=>{
  it('defaults to a deterministic dry-run and cannot perform writes',()=>{
    const p=prepareProvisionPlan(evidence());
    expect(p.mode).toBe('plan-only');expect(p.applySupported).toBe(false);
    expect(p.planHash).toBe(prepareProvisionPlan(evidence()).planHash);
    expect(p.next).toBe('insert-central-tenant');
    expect(p.requirements).toContain('hash-namespace:tower-feedback-token:v1:');
  });
  it.each([
    (e:ProvisionEvidence)=>{e.central.observedHost='other.example.com';},
    (e:ProvisionEvidence)=>{e.central.observedDatabase='other';},
    (e:ProvisionEvidence)=>{e.customer.observedBackendUid=1001;},
    (e:ProvisionEvidence)=>{e.schema.liveDefinitionMatches=false;},
    (e:ProvisionEvidence)=>{e.schema.sourceSha256='0'.repeat(64);},
    (e:ProvisionEvidence)=>{e.schema.backupVerified=false;},
    (e:ProvisionEvidence)=>{e.env.canonicalNoSymlinks=false;},
    (e:ProvisionEvidence)=>{e.env.regularSingleLink=false;},
    (e:ProvisionEvidence)=>{e.env.parentTrusted=false;},
    (e:ProvisionEvidence)=>{e.env.keys[0].count=2;},
    (e:ProvisionEvidence)=>{e.env.keys[0].count=1;},
    (e:ProvisionEvidence)=>{e.tenant.label='customer:other';},
    (e:ProvisionEvidence)=>{e.central.origin='https://feedback.example.com/path';},
    (e:ProvisionEvidence)=>{e.enrollment.tenantExists=true;},
  ])('rejects identity/schema/overwrite/ownership ambiguities',change=>{
    const e=evidence();change(e);expect(()=>prepareProvisionPlan(e)).toThrow('feedback_provision_plan_invalid');
  });
  it('accepts database and role identifiers with underscores',()=>{
    const e=evidence();e.central.expectedDatabase=e.central.observedDatabase='tower_chat';
    e.central.expectedRole=e.central.observedRole='tower_backend';
    expect(prepareProvisionPlan(e).target.central.database).toBe('tower_chat');
  });
  it('binds a changed env preimage separately without changing the resume target',()=>{
    const e=evidence(); const before=prepareProvisionPlan(e);
    e.env.contentSha256='c'.repeat(64);const after=prepareProvisionPlan(e);
    expect(after.planHash).toBe(before.planHash);expect(after.evidenceHash).not.toBe(before.evidenceHash);
    expect(after.evidenceVerifiedByPlanner).toBe(false);
  });
  it('rejects missing central state and inconsistent customer state on resume',()=>{
    const e=evidence(); const p=prepareProvisionPlan(e);
    e.enrollment.receiptPhase='central-enrolled';e.enrollment.receiptPlanHash=p.planHash;
    expect(()=>prepareProvisionPlan(e)).toThrow();
    e.enrollment.tenantExists=true;e.enrollment.tenantMatchesIntended=true;e.enrollment.sameTokenConfirmedInMemory=true;
    e.enrollment.customerConfigured=true;
    expect(()=>prepareProvisionPlan(e)).toThrow();
  });
  it('resumes after central insert with same receipt and same token, without rotation',()=>{
    const e=evidence(); const p=prepareProvisionPlan(e);
    e.enrollment={tenantExists:true,tenantMatchesIntended:true,sameTokenConfirmedInMemory:true,customerConfigured:false,receiptPhase:'prepared',receiptPlanHash:p.planHash};
    expect(prepareProvisionPlan(e).next).toBe('install-customer-env-with-same-token');
    e.enrollment.sameTokenConfirmedInMemory=false;
    expect(()=>prepareProvisionPlan(e)).toThrow('feedback_provision_plan_invalid');
  });
  it('reconciles env-write-before-receipt failure without rewriting configuration',()=>{
    const e=evidence();const p=prepareProvisionPlan(e);
    e.enrollment={tenantExists:true,tenantMatchesIntended:true,sameTokenConfirmedInMemory:true,customerConfigured:true,receiptPhase:'central-enrolled',receiptPlanHash:p.planHash};
    e.env.keys.forEach(k=>{k.count=1;k.matchesIntended=true;});
    expect(prepareProvisionPlan(e).next).toBe('verify-receipt-and-backend');
    e.enrollment.receiptPhase='verified';expect(prepareProvisionPlan(e).next).toBe('complete');
    e.enrollment.receiptPlanHash='c'.repeat(64);expect(()=>prepareProvisionPlan(e)).toThrow();
  });
  it('rejects unknown keys and never reflects secret-like input',()=>{
    expect(()=>prepareProvisionPlan({...evidence(),token:'synthetic-do-not-echo'})).toThrow('feedback_provision_plan_invalid');
    const p=prepareProvisionPlan(evidence());expect(JSON.stringify(p)).not.toContain('token_hash');
  });
  it('CLI rejects apply before reading stdin and returns only a fixed error',()=>{
    const r=spawnSync(process.execPath,['--import','tsx','packages/backend/services/feedback-intake/provision-plan-cli.ts','--apply'],{input:'synthetic-do-not-echo',encoding:'utf8'});
    expect(r.status).toBe(1);expect(r.stdout).toBe('');expect(r.stderr).toBe('feedback_provision_plan_invalid_or_apply_not_supported\n');
  });
  it('CLI refuses oversized input without echoing any content',()=>{
    const r=spawnSync(process.execPath,['--import','tsx','packages/backend/services/feedback-intake/provision-plan-cli.ts'],{input:'x'.repeat(16385),encoding:'utf8'});
    expect(r.status).toBe(1);expect(r.stdout).toBe('');
    expect(r.stderr).toBe('feedback_provision_plan_invalid_or_apply_not_supported\n');
  });
  it('CLI default and explicit dry-run produce the same secret-free plan',()=>{
    for(const args of [[],['--dry-run']]){
      const r=spawnSync(process.execPath,['--import','tsx','packages/backend/services/feedback-intake/provision-plan-cli.ts',...args],{input:JSON.stringify(evidence()),encoding:'utf8'});
      expect(r.status).toBe(0);expect(JSON.parse(r.stdout).applySupported).toBe(false);
    }
  });
});
