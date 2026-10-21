import {it,expect,vi} from 'vitest';
import {assertLockedCustomerAuthority} from './pg-locked-authority.js';
const binding={customerId:'fixture',instanceId:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222',actorUserId:1};
const scope={customerId:'fixture',instanceId:binding.instanceId,approvalHash:'a'.repeat(64)};
it('paid execute locks exact model; missing or changed approved model cannot consume',async()=>{const c={query:vi.fn(async()=>({rowCount:1,rows:[{}]}))} as any;const b={...binding,smokeModel:'~deepseek/deepseek-pro-latest'};await assertLockedCustomerAuthority(c,{...scope,operation:'smoke-execute',binding:b,model:b.smokeModel});expect(c.query.mock.calls.some((x:any[])=>x[0].includes('lock_customer_smoke_model')&&x[1][2]===b.smokeModel)).toBe(true);await expect(assertLockedCustomerAuthority(c,{...scope,operation:'smoke-execute',binding:b,model:'gpt-6.1-sol'})).rejects.toThrow('model_denied');});
