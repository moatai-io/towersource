import {it,expect,vi} from 'vitest';import {outboundAiReportClient} from './outbound-ai-report-client.js';
it('waits for durable result, rechecks authority, and retries only reporting',async()=>{
 const instanceId='11111111-1111-4111-8111-111111111111',executionHash='a'.repeat(64);let ready=false;
 const report={executionHash,instanceId,model:'gpt-6.1-sol' as const,verified:true as const,requestId:'r',evidenceId:instanceId,usageMicrousd:1};
 const authority=vi.fn(async()=>{}),fetcher=vi.fn(async()=>Response.json({status:'received',verifiedByControlPlane:false}));
 const client=outboundAiReportClient({baseUrl:'https://fixture',credential:'a'.repeat(43),executionId:instanceId,instanceId,executionHash},{assertCurrent:authority,readResult:async()=>ready?report:null},fetcher);
 const signal=new AbortController().signal;expect(await client.tick(signal)).toEqual({status:'waiting'});expect(fetcher).not.toHaveBeenCalled();ready=true;
 fetcher.mockRejectedValueOnce(Error('lost response'));await expect(client.tick(signal)).rejects.toThrow('lost response');
 expect(await client.tick(signal)).toEqual({status:'received',verifiedByControlPlane:false});expect(fetcher).toHaveBeenCalledTimes(2);
 authority.mockRejectedValueOnce(Error('revoked'));await expect(client.tick(signal)).rejects.toThrow('revoked');expect(fetcher).toHaveBeenCalledTimes(2);
});
