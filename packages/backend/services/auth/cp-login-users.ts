import {randomBytes,createHash} from 'node:crypto';
import {getPgPool} from '../../db/pg.js';
import {generateToken,hashPassword} from './auth.js';
import type {CpLoginIdentity,CpLoginSessionPort} from './cp-login-exchange.js';
/** Installed mapping schema required. External subject cannot attach to an existing local username. */
export function cpLoginUsers(issuer:string):CpLoginSessionPort {
 return {async createSession(x){const payload=await ensureCpMappedUser(issuer,x);return generateToken(payload,{maxAgeSeconds:300});}};
}
/** Trusted installation/SSO caller only: prepare exact local identity without minting a session. */
export async function ensureCpMappedUser(issuer:string,x:CpLoginIdentity){
 if(new URL(issuer).protocol!=='https:')throw Error('cp_identity_issuer_invalid');

  const passwordHash=await hashPassword(randomBytes(48).toString('base64url'));
  const c=await getPgPool().connect();let payload:{userId:number;username:string;role:string;authEpoch:number};
  try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[issuer+'|'+x.subjectId+'|'+x.organizationId]);
   const result=await c.query(`SELECT u.id,u.username,u.role,u.disabled,u.approval_status,u.auth_epoch FROM cp_user_identities m JOIN users u ON u.id=m.user_id WHERE m.issuer=$1 AND m.subject_id=$2 AND m.organization_id=$3 FOR UPDATE OF m,u`,[issuer,x.subjectId,x.organizationId]);
   const role=x.role==='owner'||x.role==='admin'?'admin':'member';let u=result.rows[0];
   if(!u){
    const username='cp_'+createHash('sha256').update(issuer+'|'+x.subjectId+'|'+x.organizationId).digest('hex').slice(0,24);
    const created=await c.query(`INSERT INTO users(username,password_hash,role,display_name,approval_status,approved_at,password_changed_at) VALUES($1,$2,$3,$4,'active',now(),now()) RETURNING id,username,role,auth_epoch`,[username,passwordHash,role,x.displayName]);u=created.rows[0];
    await c.query('INSERT INTO cp_user_identities(issuer,subject_id,organization_id,user_id) VALUES($1,$2,$3,$4)',[issuer,x.subjectId,x.organizationId,u.id]);
   }else{
    if(Number(u.disabled)!==0||u.approval_status!=='active')throw Error('cp_local_user_disabled');
    if(u.role!==role){const updated=await c.query('UPDATE users SET role=$2,auth_epoch=auth_epoch+1 WHERE id=$1 RETURNING role,auth_epoch',[u.id,role]);Object.assign(u,updated.rows[0]);}
   }
   payload={userId:u.id,username:u.username,role:u.role,authEpoch:Number(u.auth_epoch??0)};await c.query('COMMIT');
  }catch{await c.query('ROLLBACK').catch(()=>{});throw Error('cp_local_identity_denied');}finally{c.release();}
  return payload;
}
