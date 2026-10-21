import {it,expect} from 'vitest';import {createServer} from 'node:http';
import {localLiteLlmManagement} from './litellm-management-http.js';
import {autoEnrollApprovedLiteLlmCustomer} from './litellm-auto-enrollment.js';
it('existing loopback HTTP management client and current issuer interoperate without external writes',async()=>{
 const approved={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'litellm' as const,credentialId:'litellm-inference'};
 const policy={...approved,teamId:'fixture-team',teamAlias:'fixture-team',keyAlias:'fixture-key',models:['gpt-6.1-sol'],modelPolicy:'gpt-only' as const,monthlyBudgetUsd:50 as const,budgetDuration:'30d' as const};
 let team:any=null,key:any=null,teamWrites=0,keyWrites=0;const paths:string[]=[];
 const server=createServer(async(req,res)=>{try{
 expect(req.headers.authorization).toBe('Bearer '+'x'.repeat(40));let text='';for await(const x of req)text+=x;const body=text?JSON.parse(text):undefined;
 const u=new URL(req.url!,'http://fixture');paths.push(req.method+' '+u.pathname);let out:unknown;
 if(req.method==='GET'&&u.pathname==='/models')out={data:[{id:'gpt-6.1-sol'}]};
 else if(req.method==='GET'&&u.pathname==='/team/list')out=team?[team]:[];
 else if(req.method==='GET'&&u.pathname==='/team/info'){expect(u.searchParams.get('team_id')).toBe(policy.teamId);out={team_info:team};}
 else if(req.method==='GET'&&u.pathname==='/key/list'){expect(u.searchParams.get('return_full_object')).toBe('true');out={keys:key?[key]:[],total_count:key?1:0,total_pages:1};}
 else if(req.method==='POST'&&u.pathname==='/team/new'){teamWrites++;team={...body,blocked:false};out=team;}
 else if(req.method==='POST'&&u.pathname==='/key/generate'){keyWrites++;key={...body,blocked:false};out={key:'synthetic-key',team_id:policy.teamId,key_alias:policy.keyAlias};}
 else throw Error('unexpected request');
 res.setHeader('content-type','application/json');res.end(JSON.stringify(out));
 }catch{res.statusCode=500;res.end('{}');}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const port=(server.address() as {port:number}).port;const client=localLiteLlmManagement({baseUrl:'http://127.0.0.1:'+port,masterKey:'x'.repeat(40)});
 const result=await autoEnrollApprovedLiteLlmCustomer(approved,policy,client);
 expect(result.providerResourceId).toBe(policy.keyAlias);expect(teamWrites).toBe(1);expect(keyWrites).toBe(1);expect(key.metadata.credential_id).toBe(approved.credentialId);
 await expect(autoEnrollApprovedLiteLlmCustomer(approved,policy,client)).rejects.toThrow();expect(keyWrites).toBe(1);expect(teamWrites).toBe(1);
 const count=paths.length;await expect(client.request('/key/delete','POST',{})).rejects.toThrow('operation_denied');await expect(client.request('http://example.test/models','GET')).rejects.toThrow('operation_denied');expect(paths).toHaveLength(count);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
