import {it,expect} from 'vitest';
import {Pool} from 'pg';
import {pgCustomerSmokeLedger} from './pg-smoke-ledger.js';
const url=process.env.CUSTOMER_SMOKE_TEST_DATABASE_URL;
it.skipIf(!url)('real PostgreSQL fences concurrent paid reservations and settles once',async()=>{
 const pool=new Pool({connectionString:url});
 const instance='22222222-2222-4222-8222-222222222222',project='33333333-3333-4333-8333-333333333333',hash='a'.repeat(64);
 const first='11111111-1111-4111-8111-111111111111',second='44444444-4444-4444-8444-444444444444';
 try{
  await pool.query(`INSERT INTO customer_runtime_approvals VALUES($1,'fixture',$2,$3,1,ARRAY['smoke-execute'],now()+interval '1 hour',false)`,[hash,instance,project]);
  for(const id of [first,second])await pool.query(`INSERT INTO customer_service_intents VALUES($1,'fixture',$2,$3,'smoke-execute',null,$4,1,now()+interval '1 hour',false,now())`,[id,instance,hash,project]);
  await pool.query(`INSERT INTO customer_smoke_budgets(instance_id,team_observed_microusd,team_observed_at) VALUES($1,0,now())`,[instance]);
  const ledger=pgCustomerSmokeLedger(pool as any,{instanceId:instance,approvalHash:hash,estimatedMicrousd:600000});
  const outcomes=await Promise.allSettled([ledger.reserve(first,600000),ledger.reserve(second,600000)]);expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const winner=outcomes[0].status==='fulfilled'?first:second;
  const before=await pool.query('SELECT reserved_microusd::text reserved,requests FROM customer_smoke_budgets');expect(before.rows).toEqual([{reserved:'600000',requests:1}]);
  await expect(ledger.reserve(winner,600000)).rejects.toThrow('denied_or_unknown');
  await ledger.reconcile(winner,'req-fixture',25);await expect(ledger.reconcile(winner,'req-fixture',25)).rejects.toThrow('denied_or_unknown');
  expect(await ledger.snapshot()).toEqual({spendMicrousd:25,requests:1});
  await pool.query(`UPDATE customer_runtime_approvals SET revoked=true`);await expect(ledger.reserve(winner===first?second:first,600000)).rejects.toThrow('denied_or_unknown');
 }finally{await pool.end();}
});
