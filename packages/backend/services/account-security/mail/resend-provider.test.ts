import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResendAccountMailProvider } from './resend-provider.js';
import { getAccountMailProvider, resetAccountMailProvider } from './mail-service.js';

const message = { kind:'login_otp' as const, to:'user@example.com', subject:'Code', text:'123456', idempotencyKey:'otp-1' };
afterEach(()=>{ vi.unstubAllEnvs(); resetAccountMailProvider(); });

describe('Resend account mail adapter',()=>{
  it('uses a deterministic idempotency key and never leaks a key into returned data',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:'mail-1'}),{status:200}));
    const provider=new ResendAccountMailProvider({apiKey:'private-test-key',from:'no-reply@example.com',fetcher:fetcher as typeof fetch});
    expect(await provider.send(message)).toEqual({providerMessageId:'mail-1'});
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({'Idempotency-Key':'otp-1',Authorization:'Bearer private-test-key'});
    expect(JSON.parse(init.body as string)).toMatchObject({from:'no-reply@example.com',to:['user@example.com'],subject:'Code',text:'123456'});
  });
  it('returns a generic failure without provider response or credentials',async()=>{
    const provider=new ResendAccountMailProvider({apiKey:'private-test-key',from:'no-reply@example.com',fetcher:async()=>new Response('secret provider message',{status:403})});
    await expect(provider.send(message)).rejects.toThrow('Resend mail delivery failed (HTTP 403)');
  });
  it('reports local config readiness but does not claim provider auth verification',async()=>{
    const provider=new ResendAccountMailProvider({apiKey:'test',from:'no-reply@example.com'});
    expect(await provider.checkConnection()).toMatchObject({configured:true,connection:'ok',detail:'local configuration only; delivery unverified'});
    expect(await new ResendAccountMailProvider({apiKey:'',from:''}).checkConnection()).toMatchObject({configured:false,connection:'unconfigured'});
  });
  it('keeps provider unconfigured by default, rejects unknown providers and wires resend explicitly',()=>{
    vi.stubEnv('TOWER_MAIL_PROVIDER',''); resetAccountMailProvider(); expect(getAccountMailProvider().name).toBe('unconfigured');
    vi.stubEnv('TOWER_MAIL_PROVIDER','unknown'); expect(()=>resetAccountMailProvider()).toThrow('Unsupported TOWER_MAIL_PROVIDER');
    vi.stubEnv('TOWER_MAIL_PROVIDER','resend'); vi.stubEnv('RESEND_API_KEY','test'); vi.stubEnv('TOWER_MAIL_FROM','no-reply@example.com');
    resetAccountMailProvider(); expect(getAccountMailProvider().name).toBe('resend');
  });
});
