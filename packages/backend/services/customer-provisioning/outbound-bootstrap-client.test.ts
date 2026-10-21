import {it,expect,vi} from 'vitest';import {redeemOutboundBootstrap} from './outbound-bootstrap-client.js';
it('validates returned identity and never retries failed bootstrap implicitly',async()=>{
 const config={baseUrl:'https://fixture',bootstrapToken:Buffer.alloc(32,1).toString('base64url'),credential:Buffer.alloc(32,2).toString('base64url'),organizationId:'org',instanceId:'vm'},signal=new AbortController().signal;
 const f=vi.fn(async()=>Response.json({organizationId:'org',instanceId:'vm'}));expect(await redeemOutboundBootstrap(config,signal,f)).toEqual({registered:true});
 f.mockResolvedValueOnce(Response.json({organizationId:'other',instanceId:'vm'}));await expect(redeemOutboundBootstrap(config,signal,f)).rejects.toThrow('identity_mismatch');
 f.mockResolvedValueOnce(new Response('',{status:403}));await expect(redeemOutboundBootstrap(config,signal,f)).rejects.toThrow('denied');expect(f).toHaveBeenCalledTimes(3);
});
