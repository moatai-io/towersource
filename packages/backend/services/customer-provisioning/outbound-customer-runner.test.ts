import {it,expect,vi} from 'vitest';import {runOutboundCustomer} from './outbound-customer-runner.js';
it('coordinates delivery then durable smoke and reporting without declaring acceptance',async()=>{
 let ready=false;const delivery={tick:vi.fn(async()=>{ready=true;return {status:'idle' as const};})};const report={tick:vi.fn(async()=>({status:'received' as const,verifiedByControlPlane:false as const}))};
 const smoke=vi.fn(async()=> 'reconciled' as const);
 const input={delivery,report,assertCurrent:async()=>{},credentialsReady:async()=>ready,ensureDurableSmoke:smoke,wait:async()=>{},signal:new AbortController().signal,maxAttempts:2,deadlineMs:10000};
 expect(await runOutboundCustomer(input)).toEqual({status:'reported',verifiedByControlPlane:false});expect(delivery.tick).toHaveBeenCalledTimes(1);expect(smoke).toHaveBeenCalledTimes(1);
 smoke.mockRejectedValueOnce(Error('unknown outcome'));await expect(runOutboundCustomer(input)).rejects.toThrow('unknown outcome');expect(smoke).toHaveBeenCalledTimes(2);expect(report.tick).toHaveBeenCalledTimes(1);
});

it('drains both outstanding ACKs on restart before considering paid execution',async()=>{
 const tick=vi.fn().mockResolvedValueOnce({status:'acknowledged',deliveryId:'one',reused:true}).mockResolvedValueOnce({status:'acknowledged',deliveryId:'two',reused:true}).mockResolvedValue({status:'idle'});
 const smoke=vi.fn(async()=>{expect(tick).toHaveBeenCalledTimes(3);return 'reconciled' as const;});
 await runOutboundCustomer({delivery:{tick},report:{tick:async()=>({status:'received',verifiedByControlPlane:false})},assertCurrent:async()=>{},credentialsReady:async()=>true,ensureDurableSmoke:smoke,wait:async()=>{},signal:new AbortController().signal,maxAttempts:3,deadlineMs:10000});
 expect(smoke).toHaveBeenCalledTimes(1);
});

it('retries temporary report admission without repeating reconciled smoke',async()=>{
 const smoke=vi.fn(async()=> 'reconciled' as const),tick=vi.fn().mockRejectedValueOnce(Error('outbound_report_request_failed')).mockResolvedValue({status:'received',verifiedByControlPlane:false});
 const result=await runOutboundCustomer({delivery:{tick:async()=>({status:'idle'})},report:{tick},assertCurrent:async()=>{},credentialsReady:async()=>true,ensureDurableSmoke:smoke,wait:async()=>{},signal:new AbortController().signal,maxAttempts:2,deadlineMs:10000});
 expect(result.status).toBe('reported');expect(smoke).toHaveBeenCalledTimes(1);expect(tick).toHaveBeenCalledTimes(2);
});
