import {beforeAll,afterAll,it,expect} from 'vitest';import {Pool} from 'pg';import fs from 'node:fs';
const url=process.env.INTERVIEW_FIXTURE_URL;const suite=url?it:it.skip;let pool:Pool;
beforeAll(async()=>{if(!url)return;if(!url.includes(':55439/'))throw new Error('Disposable fixture only');process.env.DATABASE_URL=url;pool=new Pool({connectionString:url});await pool.query('CREATE TABLE IF NOT EXISTS messages(id text PRIMARY KEY,session_id text,role text,content text,metadata jsonb)');const migration=fs.readFileSync('packages/backend/db/migrations/232_agent_initial_interviews.sql','utf8');await pool.query(migration);await pool.query(migration);await pool.query('TRUNCATE agent_initial_interviews,messages');});
afterAll(async()=>{if(pool)await pool.end();});
suite('real PostgreSQL: claim race, atomic question/answer, stale result and no overlapping retry',async()=>{
 const d=await import('./durable-interview.js');await d.scheduleDurableInterview('fixture-p','fixture-s',1);
 const claims=await Promise.all([d.claimDurableInterview('fixture-p'),d.claimDurableInterview('fixture-p')]);expect(claims.filter(Boolean)).toHaveLength(1);const claim=claims.find(Boolean);
 const json=JSON.stringify({greeting:'안내',question:'우선 결과물은?',plan:null});expect(await d.commitInterviewArtifact('fixture-s',json,'bad','stale')).toBe(false);
 expect(await d.commitInterviewArtifact('fixture-s',json,'artifact',claim.token)).toBe(true);const state=await d.readDurableInterview('fixture-p');expect(state.status).toBe('awaiting');
 await expect(d.answerDurableInterview('other-project','fixture-s',state.question_id,'답변')).rejects.toThrow();
 await d.answerDurableInterview('fixture-p','fixture-s',state.question_id,'체크리스트');await expect(d.answerDurableInterview('fixture-p','fixture-s',state.question_id,'중복')).rejects.toThrow();expect(await d.durableInterviewContext('fixture-p')).toContain('체크리스트');
 await d.scheduleDurableInterview('fixture-c','fixture-cs',1);await d.claimDurableInterview('fixture-c');await d.cancelInterviewForHuman('fixture-cs');expect(await d.commitInterviewArtifact('fixture-cs',json,'late')).toBe(false);
 await d.scheduleDurableInterview('fixture-expired','fixture-es',1);await d.claimDurableInterview('fixture-expired');await pool.query("UPDATE agent_initial_interviews SET lease_until=now()-interval '1 second' WHERE project_id='fixture-expired'");expect(await d.claimDurableInterview('fixture-expired')).toBeFalsy();
});

suite('real transaction rolls back assistant insertion when state update fails',async()=>{
 const d=await import('./durable-interview.js');await d.scheduleDurableInterview('rollback-p','rollback-s',1);const c=await d.claimDurableInterview('rollback-p');
 await pool.query(`CREATE OR REPLACE FUNCTION fixture_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id='rollback-p' AND NEW.status='awaiting' THEN RAISE EXCEPTION 'fixture injected failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_failure BEFORE UPDATE ON agent_initial_interviews FOR EACH ROW EXECUTE FUNCTION fixture_fail_update()`);
 try{await expect(d.commitInterviewArtifact('rollback-s',JSON.stringify({greeting:'안내',question:'질문',plan:null}),'rollback-artifact',c.token)).rejects.toThrow();expect((await pool.query("SELECT count(*)::int n FROM messages WHERE id='rollback-artifact'")).rows[0].n).toBe(0);const row=(await pool.query("SELECT status,question_id FROM agent_initial_interviews WHERE project_id='rollback-p'")).rows[0];expect(row).toEqual({status:'running',question_id:null});}finally{await pool.query('DROP TRIGGER fixture_failure ON agent_initial_interviews;DROP FUNCTION fixture_fail_update()');}
});
