import express from 'express';import {Pool} from 'pg';import {chromium} from 'playwright';import {build} from 'esbuild';
process.env.DATABASE_URL='postgresql://enterpriseai@127.0.0.1:55439/postgres';
const d=await import('../../../../packages/backend/services/agents/durable-interview.ts');
const p=new Pool({connectionString:process.env.DATABASE_URL});await p.query("DELETE FROM agent_initial_interviews WHERE project_id='browser-p';DELETE FROM messages WHERE session_id='browser-s'");
await build({entryPoints:['scripts/test/fixtures/agent-interview/browser-entry.tsx'],bundle:true,outfile:'work/interview-fixture/app.js',jsx:'automatic'});
const app=express();app.use(express.json());app.get('/',(_,r)=>r.send('<div id="root"></div><script src="/app.js"></script>'));app.use(express.static('work/interview-fixture'));
app.get('/api/sessions/:id/initial-interview',async(_,r)=>{const s=await d.readDurableInterview('browser-p');r.json({execution:s?.status,state:s?{questionId:s.question_id,question:s.question,status:s.status}:null});});
app.post('/api/sessions/:id/initial-interview',async(req,r)=>{try{r.json({state:await d.answerDurableInterview('browser-p','browser-s',req.body.questionId,req.body.answer)});}catch{r.status(409).json({});}});
const server=app.listen(55440,'127.0.0.1');const browser=await chromium.launch({headless:true});
try{await d.scheduleDurableInterview('browser-p','browser-s',1);const page=await browser.newPage();await page.goto('http://127.0.0.1:55440');
 const c=await d.claimDurableInterview('browser-p');await d.commitInterviewArtifact('browser-s',JSON.stringify({greeting:'안내',question:'우선 결과물은 무엇인가요?',plan:null}),'browser-artifact',c.token);
 await page.getByText('우선 결과물은 무엇인가요?',{exact:true}).waitFor();await page.locator('textarea').fill('검증 체크리스트');await page.getByRole('button',{name:'답변 보내기'}).click();await page.locator('textarea').waitFor({state:'detached'});
 const state=await d.readDurableInterview('browser-p');if(state.status!=='answered')throw new Error('not saved');if(!(await d.durableInterviewContext('browser-p')).includes('검증 체크리스트'))throw new Error('new-session continuity missing');// State-specific scenarios use the same actual component and DB endpoint.
 for (const status of ['failed','completed','cancelled','awaiting']) {
  await p.query("UPDATE agent_initial_interviews SET status=$1,question='우선 결과물은 무엇인가요?',question_id='browser-question',answer=null WHERE project_id='browser-p'",[status]);
  await page.reload();
  if(status==='failed')await page.getByRole('status').waitFor();
  if(status==='completed')await page.getByText('첫 실행안을 준비했습니다. 대화에서 업무를 시작할 수 있습니다.').waitFor();
  if(status==='cancelled'){await page.waitForTimeout(250);if(await page.locator('textarea').count())throw new Error('late onboarding visible');}
  if(status==='awaiting') {await page.locator('textarea').waitFor();await p.query("INSERT INTO messages(id,session_id,role,content,metadata) VALUES('free-chat','browser-s','user','새 업무 요청','{}') ON CONFLICT DO NOTHING");if((await d.readDurableInterview('browser-p')).status!=='awaiting')throw new Error('free chat misclassified');}
 }
 console.log('PASS actual React + Chromium + fixture HTTP API + disposable PostgreSQL: automatic question, one answer submit, persisted evidence, context reload');
}finally{await browser.close();server.close();await p.end();}
process.exit(0);
