import {it,expect} from 'vitest';import {customerLiteLlmSmokePorts,decimalUsdToMicrousd,type CustomerSmokeLedger} from './litellm-smoke-ports.js';
const now=Date.parse('2026-10-01T00:00:00Z'),intentId='11111111-1111-4111-8111-111111111111';
function fixture(){let paid=0,reserved=0,reconciled=0;const ledger:CustomerSmokeLedger={async snapshot(){return {spendMicrousd:0,requests:0};},async estimate(){return 100;},async reserve(){reserved++;},async reconcile(){reconciled++;}};const deps={async credentials(){return {baseUrl:'https://fixture.invalid/v1',apiKey:'fixture-virtual-key'};},async usage(){return {source:'litellm-spendlogs' as const,scope:'team' as const,period:'calendar_month' as const,days:30,key:{},team:{},summary:{cost_usd:'0.00001',observed_at:new Date(now).toISOString()},budget_observation:{source:'litellm-team-budget' as const,spend_usd:'0.00001',observed_at:new Date(now).toISOString()},budget_window:null,daily:[],models:[],projects:[]};},async turnSpend(){return [{requestId:'req-1',rootTurnId:intentId,spend:0.00009,status:'success'}];},async fetch(_url:any,opts:any){const payload=JSON.parse(opts.body);expect(payload.metadata.tower_root_turn_id).toBe(intentId);expect(payload.metadata.root_turn_id).toBeUndefined();paid++;return Response.json({id:'req-1',model:'gpt-6.1-sol',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'TOWER_SMOKE_OK'}]}]});}};return {ledger,deps,paid:()=>paid,reserved:()=>reserved,reconciled:()=>reconciled};}
const input={model:'gpt-6.1-sol',prompt:'Reply with exactly: TOWER_SMOKE_OK',maxOutputTokens:32,intentId};
it('converts USD conservatively without silent float rounding down',()=>{expect(decimalUsdToMicrousd('0.00000001')).toBe(1);expect(decimalUsdToMicrousd('50')).toBe(50000000);expect(()=>decimalUsdToMicrousd(-1)).toThrow();expect(()=>decimalUsdToMicrousd('NaN')).toThrow();});
it('canonical usage freshness, reservation, one response and exhaustive spend reconcile',async()=>{const f=fixture();const p=customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now);expect((await p.usage()).teamSpendMicrousd).toBe(10);expect((await p.execute(input)).usageMicrousd).toBe(90);expect(f.paid()).toBe(1);expect(f.reserved()).toBe(1);expect(f.reconciled()).toBe(1);});
it('unknown outcome never retries or reconciles',async()=>{const f=fixture();f.deps.fetch=async()=>{throw Error('secret-provider-error');};await expect(customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).execute(input)).rejects.toThrow('outcome_unknown');expect(f.reserved()).toBe(1);expect(f.reconciled()).toBe(0);});
it('missing provider timestamp fails rather than manufacturing freshness',async()=>{const f=fixture();f.deps.usage=async()=>({...await fixture().deps.usage(),budget_observation:{source:'litellm-team-budget',spend_usd:'1'}} as any);await expect(customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).usage()).rejects.toThrow('freshness_unverified');});
it('price unknown and spend model mismatch fail closed',async()=>{const f=fixture();f.ledger.estimate=async()=>0;await expect(customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).execute(input)).rejects.toThrow('price_unverified');expect(f.paid()).toBe(0);const g=fixture();g.deps.fetch=async()=>Response.json({id:'req-1',model:'~deepseek/deepseek-pro-latest',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'TOWER_SMOKE_OK'}]}]});await expect(customerLiteLlmSmokePorts(g.ledger,g.deps,()=>now).execute(input)).rejects.toThrow('response_unverified');expect(g.reconciled()).toBe(0);});

it('requires actual exact assistant answer; completed envelope is insufficient',async()=>{
 for(const output of [undefined,[],[{type:'message',role:'assistant',content:[{type:'output_text',text:'wrong answer'}]}],[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'no'}]}]]){
  const f=fixture();f.deps.fetch=async()=>Response.json({id:'req-1',model:'gpt-6.1-sol',status:'completed',output});
  await expect(customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).execute(input)).rejects.toThrow('response_unverified');expect(f.reconciled()).toBe(0);
 }
});
it('accepts bounded opaque response IDs only with exact independent spend evidence',async()=>{
 for(const size of [485,2048]){
  const f=fixture();const id='resp_'+ 'a'.repeat(size-6)+'=';
  f.deps.fetch=async()=>Response.json({id,model:input.model,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'TOWER_SMOKE_OK'}]}]});
  f.deps.turnSpend=async()=>[{requestId:id,rootTurnId:input.intentId,spend:'0.000001',status:'success'}];
  expect((await customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).execute(input)).requestId).toBe(id);expect(f.reconciled()).toBe(1);
 }
});
it('rejects oversized, whitespace, control and URL-query response IDs without reconciliation',async()=>{
 for(const id of ['x'.repeat(2049),'bad id','bad\nid','bad?id','bad#id']){
  const f=fixture();f.deps.fetch=async()=>Response.json({id,model:input.model,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'TOWER_SMOKE_OK'}]}]});
  await expect(customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).execute(input)).rejects.toThrow('response_unverified');expect(f.reconciled()).toBe(0);
 }
});
it('sends provider-safe metadata separately from retained internal spend metadata',async()=>{const f=fixture();const original=f.deps.fetch;let sent:any;f.deps.fetch=async(url:any,options:any)=>{sent=JSON.parse(options.body);return original(url,options);};await customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).execute(input);expect(sent.metadata).toEqual({tower_root_turn_id:input.intentId});expect(sent.litellm_metadata).toEqual({spend_logs_metadata:{tower_root_turn_id:input.intentId}});});
it('persists validated response before a failed spend query and never retries inference',async()=>{const f=fixture();const order:string[]=[];f.ledger.recordResponse=async(_intent,r)=>{expect(r.sentinel).toBe('TOWER_SMOKE_OK');order.push('saved');};f.deps.turnSpend=async()=>{order.push('spend');throw Error('timeout');};await expect(customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).execute(input)).rejects.toThrow('timeout');expect(order).toEqual(['saved','spend']);expect(f.reconciled()).toBe(0);});
it('recovers durable response without a second fetch',async()=>{const f=fixture();f.ledger.loadResponse=async()=>({requestId:'req-1',model:'gpt-6.1-sol',sentinel:'TOWER_SMOKE_OK'});f.deps.fetch=async()=>{throw Error('must not infer');};expect(await customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).recover!(input.intentId,new AbortController().signal,'gpt-6.1-sol')).toBe(true);expect(f.reconciled()).toBe(1);});
it('missing saved evidence cannot authorize recovery',async()=>{const f=fixture();expect(await customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).recover!(input.intentId,new AbortController().signal,'gpt-6.1-sol')).toBe(false);expect(f.reconciled()).toBe(0);});
it('DeepSeek response and recovery require exact approved model; no fallback',async()=>{
 const f=fixture(),model='~deepseek/deepseek-pro-latest';f.deps.fetch=async(_u,init)=>{expect(JSON.parse(String(init!.body)).model).toBe(model);return Response.json({id:'fixture-response',model,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'TOWER_SMOKE_OK'}]}]});};
 f.deps.turnSpend=async()=>[{requestId:'fixture-response',rootTurnId:input.intentId,spend:0.00009,status:'success'}];expect((await customerLiteLlmSmokePorts(f.ledger,f.deps,()=>now).execute({...input,model})).model).toBe(model);
});
