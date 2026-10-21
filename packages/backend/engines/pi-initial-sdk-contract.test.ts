import {it,expect,vi} from 'vitest';import type {EngineCallbacks,RunOpts} from './types.js';
vi.mock('../services/agent-turn/recovery-coordinator.js',()=>({tryClaimForegroundAgentTurn:async()=>({claimed:true,token:'fixture'}),completeAgentTurnRecovery:async()=>{},releaseAgentTurnRecovery:async()=>{},renewAgentTurnRecovery:async()=>true}));
vi.mock('../services/workbench/workbench-rollout.js',()=>({resolveWorkbenchRollout:async()=>({enabled:false})}));
import {PiEngine} from './pi-engine.js';
it('real Pi run drives SDK-shaped events through actual saveMessage and clears busy state',async()=>{
 const engine=new PiEngine();let listener:(e:unknown)=>void=()=>{};const msg={role:'assistant',content:[{type:'text',text:'{"greeting":"안내","question":"목표는?","plan":null}'}],stopReason:'stop',usage:{input:1,output:2,totalTokens:3,cost:{input:0,output:0,total:0}},timestamp:Date.now()};
 const sdk={model:{id:'fixture',provider:'fixture',contextWindow:10000},thinkingLevel:'off',setThinkingLevel(){},state:{messages:[]},agent:{state:{messages:[]}},isIdle:true,subscribe(cb:typeof listener){listener=cb;return()=>{};},async prompt(){listener({type:'message_start',message:msg});listener({type:'message_end',message:msg});listener({type:'agent_end',messages:[msg]});},async abort(){},getContextUsage(){return {tokens:1,contextWindow:10000,percent:0.01};}};
 // Lowest feasible seam: SDK Session construction, not PiEngine.run or callbacks.
 vi.spyOn(engine as never,'createSession' as never).mockImplementation((async(_s:string,_o:RunOpts,c:EngineCallbacks)=>{await c.claimSessionId('fixture-session');return {session:sdk,isRunning:false,abortRequested:false,activePrompt:null,_abortResolve:null,harness:{id:'tower-default',version:1},toolContext:{},promptStaticTokenEstimate:1};}) as never);
 let claimed=false,saved=false;const cb:EngineCallbacks={askUser:async()=>'',claimSessionId:async()=>{claimed=true;},saveMessage:async m=>{saved=m.role==='assistant';},updateMessageContent:async()=>{},attachToolResult:async()=>{},updateMessageMetrics:async()=>{}};
 const events=[];for await(const e of engine.run('sdk-fixture','initial',{cwd:'.',rootTurnId:'root',initialInterview:true},cb))events.push(e);
 expect(claimed).toBe(true);expect(saved).toBe(true);expect(engine.isRunning('sdk-fixture')).toBe(false);
 sdk.prompt=async()=>{throw new Error('synthetic SDK failure');};
 for await(const e of engine.run('sdk-fixture','initial',{cwd:'.',rootTurnId:'failure-root',initialInterview:true},cb)){}
 expect(engine.isRunning('sdk-fixture')).toBe(false);
},15000);

it('steering interrupts and resumes inside one Tower run, saves the answer and delivers the steer once', async () => {
 const engine = new PiEngine();
 let listener: (e: any) => void = () => {};
 let started!: () => void;
 let finish!: () => void;
 const ready = new Promise<void>(r => { started = r; });
 const queued: string[] = [];
 let aborts = 0, continuations = 0;
 const message = (text: string, stopReason: string) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason, usage: { input: 1, output: 1, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } }, timestamp: Date.now() });
 const sdk: any = {
  model: { id: 'fixture', provider: 'fixture', contextWindow: 10000 }, thinkingLevel: 'off', setThinkingLevel() {},
  agent: { state: { messages: [] }, async continue() {
   continuations++;
   expect(queued).toEqual(['change direction']);
   queued.length = 0;
   listener({ type: 'queue_update', steering: [], followUp: [] });
   const msg = message('new answer', 'stop');
   listener({ type: 'message_start', message: msg });
   listener({ type: 'message_end', message: msg });
   listener({ type: 'agent_end', messages: [msg] });
  } },
  isIdle: true,
  subscribe(cb: typeof listener) { listener = cb; return () => {}; },
  async prompt() { sdk.isIdle = false; started(); await new Promise<void>(r => { finish = r; }); sdk.isIdle = true; },
  async steer(text: string) { queued.push(text); listener({ type: 'queue_update', steering: [...queued], followUp: [] }); },
  async abort() { aborts++; const msg = message('partial', 'aborted'); listener({ type: 'message_end', message: msg }); listener({ type: 'agent_end', messages: [msg] }); finish(); },
  async _handlePostAgentRun() { return false; }, async _emitAgentSettled() {},
  getContextUsage() { return { tokens: 1, contextWindow: 10000, percent: 0.01 }; },
 };
 const entry = { session: sdk, isRunning: false, abortRequested: false, activePrompt: null, _abortResolve: null, harness: { id: 'tower-default', version: 1 }, toolContext: {}, promptStaticTokenEstimate: 1 };
 vi.spyOn(engine as never, 'createSession' as never).mockImplementation((async () => { (engine as any).sessions.set('steer-fixture', entry); return entry; }) as never);
 const saved: any[] = [];
 const callbacks: EngineCallbacks = { askUser: async () => '', claimSessionId: async () => {}, saveMessage: async m => { saved.push(m); }, updateMessageContent: async () => {}, attachToolResult: async () => {}, updateMessageMetrics: async () => {} };
 const events: any[] = [];
 const running = (async () => { for await (const event of engine.run('steer-fixture', 'initial', { cwd: '.', rootTurnId: 'steer-root', initialInterview: true }, callbacks)) events.push(event); })();
 await ready;
 await engine.steer('steer-fixture', 'change direction', 'steer-message');
 await running;
 expect(aborts).toBe(1);
 expect(continuations).toBe(1);
 expect(events.filter(e => e.type === 'steer_delivered')).toHaveLength(1);
 expect(events.filter(e => e.type === 'turn_done')).toHaveLength(1);
 expect(events.filter(e => e.type === 'engine_error')).toHaveLength(0);
 expect(saved.some(m => JSON.stringify(m).includes('new answer'))).toBe(true);
 expect(engine.isRunning('steer-fixture')).toBe(false);
}, 15000);
