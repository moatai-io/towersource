import { createHash } from 'node:crypto';
import { transaction } from '../../db/pg-repo.js';
import { goalCommandSchema } from './goal-session.js';
import { transitionGoal } from './goal-transition.js';
import type { ManagedGoal } from './goal-manager.js';
import type { GoalTransaction } from './goal-manager-store.js';
import { createManagedGoalGuard } from './managed-goal-guard.js';

/** Server-only explicit admission; never accepts caller-supplied goal identity.
 * Registers a goal on the already-owned initial user turn, not a new engine run.
 * Must not be exposed until explicit capability admission and schema are installed.
 */
export function createManagedGoalStart(binding: {
  userId:number; projectId:string; sessionId:string; rootTurnId:string;
  ownerToken:string; ownerBootId:string; explicitlyAuthorized:boolean;
}, transact:GoalTransaction=transaction) {
  const bound=Object.freeze({...binding});
  return async (input:unknown):Promise<ManagedGoal> => {
    if(!bound.explicitlyAuthorized) throw new Error('GOAL_START_DENIED');
    const command=goalCommandSchema.parse(input);
    if(command.action!=='start') throw new Error('GOAL_START_REQUIRED');
    const id=createHash('sha256').update(JSON.stringify([bound.userId,bound.projectId,bound.sessionId,bound.rootTurnId])).digest('hex');
    const fingerprint=JSON.stringify(command);
    return transact(async client=>{
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      // Serialize missing-row admission without locking session before existing goals.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`goal-start:${id}`]);
      const rows=await client.query<{record:ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1 FOR UPDATE',[id]);
      const candidate:ManagedGoal={id,userId:bound.userId,projectId:bound.projectId,sessionId:bound.sessionId,
        version:1,state:transitionGoal(null,command),activeExecution:{rootTurnId:bound.rootTurnId,startProgressVersion:0},
        progressVersion:0,dispatched:1,maxExecutions:Math.min(45,command.maxCycles*3),processedTerminalIds:[]};
      const guard=createManagedGoalGuard({...bound,goalId:id,sourceUserMessageId:bound.rootTurnId});
      if(!await guard.validate(client,candidate,null)) throw new Error('GOAL_START_DENIED');
      if(rows.rowCount) {
        const previous=await client.query<{fingerprint:string}>('SELECT fingerprint FROM managed_goal_commands WHERE goal_id=$1 AND request_id=$2',[id,'__admission']);
        if(previous.rows[0]?.fingerprint!==fingerprint) throw new Error('GOAL_START_CONFLICT');
        return rows.rows[0].record;
      }
      await client.query('INSERT INTO managed_goals(id,record) VALUES($1,$2::jsonb)',[id,JSON.stringify(candidate)]);
      await client.query('INSERT INTO managed_goal_commands(goal_id,request_id,fingerprint) VALUES($1,$2,$3)',[id,'__admission',fingerprint]);
      return candidate;
    });
  };
}
