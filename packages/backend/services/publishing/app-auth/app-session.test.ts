import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {AppSessionBroker} from './app-session';
const audience={appId:'app-a',projectId:'project-a',origin:'https://app.example.com'};const identity={userId:1,audience};const verifier='a'.repeat(43);const challenge=createHash('sha256').update(verifier).digest('base64url');
describe('app session spike',()=>{
 it('exchanges once and binds session to app',async()=>{const b=new AppSessionBroker(async()=>true);const {code}=await b.issue(identity,challenge);const {token}=await b.exchange(code,verifier,audience);expect((await b.authenticate(token,audience)).userId).toBe(1);await expect(b.exchange(code,verifier,audience)).rejects.toThrow();await expect(b.authenticate(token,{...audience,appId:'b'})).rejects.toThrow()});
 it('rejects wrong verifier and wrong audience',async()=>{const b=new AppSessionBroker(async()=>true);const {code}=await b.issue(identity,challenge);await expect(b.exchange(code,'b'.repeat(43),audience)).rejects.toThrow();await expect(b.exchange(code,verifier,{...audience,origin:'https://other.example.com'})).rejects.toThrow()});
 it('checks current policy on every authenticated request',async()=>{let allowed=true;const b=new AppSessionBroker(async()=>allowed);const {code}=await b.issue(identity,challenge);const {token}=await b.exchange(code,verifier,audience);allowed=false;await expect(b.authenticate(token,audience)).rejects.toThrow('access_denied')});
 it('expires codes and sessions',async()=>{let now=0;const b=new AppSessionBroker(async()=>true,()=>now);const first=await b.issue(identity,challenge);now=60000;await expect(b.exchange(first.code,verifier,audience)).rejects.toThrow();const next=await b.issue(identity,challenge);const {token}=await b.exchange(next.code,verifier,audience);now+=300000;await expect(b.authenticate(token,audience)).rejects.toThrow()});
 it('allows only one concurrent exchange',async()=>{const b=new AppSessionBroker(async()=>true);const {code}=await b.issue(identity,challenge);const out=await Promise.allSettled([b.exchange(code,verifier,audience),b.exchange(code,verifier,audience)]);expect(out.filter(x=>x.status==='fulfilled')).toHaveLength(1)});
 it('revokes both pending codes and active sessions',async()=>{const b=new AppSessionBroker(async()=>true);const first=await b.issue(identity,challenge);const {token}=await b.exchange(first.code,verifier,audience);const pending=await b.issue(identity,challenge);b.revokeUser(1);await expect(b.authenticate(token,audience)).rejects.toThrow();await expect(b.exchange(pending.code,verifier,audience)).rejects.toThrow()});
 it('rejects non-HTTPS or path-bearing audiences',async()=>{const b=new AppSessionBroker(async()=>true);for(const origin of ['http://app.example.com','https://app.example.com/path'])await expect(b.issue({...identity,audience:{...audience,origin}},challenge)).rejects.toThrow()});
});
it('does not mint a session after logout races with authorization',async()=>{
 let release!:(ok:boolean)=>void;let calls=0;
 const broker=new AppSessionBroker(async()=>{calls++;if(calls===2)return new Promise<boolean>(r=>{release=r});return true;});
 const {code}=await broker.issue(identity,challenge);
 const exchange=broker.exchange(code,verifier,audience);
 broker.revokeUser(1);release(true);
 await expect(exchange).rejects.toThrow('access_denied');
});
it('does not issue a pending ticket after logout',async()=>{
 let release!:(ok:boolean)=>void;
 const broker=new AppSessionBroker(()=>new Promise<boolean>(r=>{release=r}));
 const issuing=broker.issue(identity,challenge);broker.revokeUser(1);release(true);
 await expect(issuing).rejects.toThrow('access_denied');
});
