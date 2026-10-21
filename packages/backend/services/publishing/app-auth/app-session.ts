import { createHash, randomBytes } from 'node:crypto';
export interface AppAudience { appId: string; projectId: string; origin: string }
export interface AppIdentity { userId: number; audience: AppAudience }
interface Ticket { identity: AppIdentity; challenge: string; expires: number }
interface Session { identity: AppIdentity; expires: number }
const digest=(s:string)=>createHash('sha256').update(s).digest('base64url');
const audienceKey=(a:AppAudience)=>JSON.stringify([a.appId,a.projectId,a.origin]);
function validate(a:AppAudience){const url=new URL(a.origin);if(!a.appId||!a.projectId||url.protocol!=='https:'||url.origin!==a.origin||url.username||url.password)throw Error('invalid_audience');}
/** In-memory security spike, NOT production authentication. No HTTP route or cookie emission. */
export class AppSessionBroker {
 private generation=0;
 private tickets=new Map<string,Ticket>();private sessions=new Map<string,Session>();
 constructor(private readonly authorize:(identity:AppIdentity)=>Promise<boolean>,private readonly clock:()=>number=Date.now, private readonly maxEntries=1000){}
 private prune(){const now=this.clock();for(const[k,v]of this.tickets)if(v.expires<=now)this.tickets.delete(k);for(const[k,v]of this.sessions)if(v.expires<=now)this.sessions.delete(k);}
 async issue(identity:AppIdentity,challenge:string){
  validate(identity.audience);if(!Number.isSafeInteger(identity.userId)||identity.userId<=0||!/^[A-Za-z0-9_-]{43}$/.test(challenge))throw Error('invalid_request');
  const generation=this.generation;const copy=structuredClone(identity);if(!await this.authorize(copy)||generation!==this.generation)throw Error('access_denied');this.prune();if(this.tickets.size>=this.maxEntries)throw Error('capacity');
  const code=randomBytes(32).toString('base64url');this.tickets.set(digest(code),{identity:copy,challenge,expires:this.clock()+60000});return {code,expiresIn:60};
 }
 async exchange(code:string,verifier:string,audience:AppAudience){
  validate(audience);if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))throw Error('invalid_exchange');
  const key=digest(code),ticket=this.tickets.get(key);
  if(!ticket||ticket.expires<=this.clock()||audienceKey(ticket.identity.audience)!==audienceKey(audience)||digest(verifier)!==ticket.challenge)throw Error('invalid_exchange');
  // Consume before awaiting policy: concurrent requests can never exchange twice.
  this.tickets.delete(key);const generation=this.generation;
  if(!await this.authorize(structuredClone(ticket.identity))||generation!==this.generation)throw Error('access_denied');this.prune();if(this.sessions.size>=this.maxEntries)throw Error('capacity');
  const token=randomBytes(32).toString('base64url');this.sessions.set(digest(token),{identity:ticket.identity,expires:this.clock()+300000});return {token,expiresIn:300};
 }
 async authenticate(token:string,audience:AppAudience){
  validate(audience);const key=digest(token),session=this.sessions.get(key);
  if(!session||session.expires<=this.clock()||audienceKey(session.identity.audience)!==audienceKey(audience))throw Error('invalid_session');
  if(!await this.authorize(structuredClone(session.identity))){this.sessions.delete(key);throw Error('access_denied');}
  if(this.sessions.get(key)!==session||session.expires<=this.clock())throw Error('invalid_session');
  return structuredClone(session.identity);
 }
 revokeUser(userId:number){this.generation++;for(const[k,v]of this.tickets)if(v.identity.userId===userId)this.tickets.delete(k);for(const[k,v]of this.sessions)if(v.identity.userId===userId)this.sessions.delete(k);}
}
