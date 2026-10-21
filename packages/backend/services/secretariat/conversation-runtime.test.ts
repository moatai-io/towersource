vi.mock('../harness/harness-store.js',()=>({getOrPinSessionHarnessSnapshot:vi.fn()}));
vi.mock('../session/session-manager.js',()=>({claimEngineSessionId:vi.fn()}));
vi.mock('../agent-turn/turn-supervisor.js',()=>({registerAgentTurn:vi.fn()}));
import {registerAgentTurn} from '../agent-turn/turn-supervisor.js';
vi.mock('../message-store.js',()=>({saveMessage:vi.fn(),updateMessageContent:vi.fn()}));
import {saveMessage} from '../message-store.js';
vi.mock('node:fs/promises',()=>({access:vi.fn()}));
import {access} from 'node:fs/promises';
import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('../../engines/index.js',()=>({getEngine:vi.fn()}));
vi.mock('../../db/pg-repo.js',()=>({queryOne:vi.fn(),execute:vi.fn()}));
vi.mock('../../config.js',()=>({config:{defaultCwd:'/work'}}));
import {getEngine} from '../../engines/index.js';
import {queryOne,execute} from '../../db/pg-repo.js';
import {runSecretaryConversation} from './conversation-runtime.js';
const args={userId:7,leaseToken:'lease',sessionId:'secretary',prompt:'이어서',history:[{id:'a',role:'user',body:'기존 대화'}],sourceFingerprint:'evidence'};
let engine:any;
beforeEach(()=>{vi.resetAllMocks();vi.mocked(access).mockResolvedValue(undefined);vi.mocked(execute).mockResolvedValue({changes:1});vi.mocked(queryOne).mockImplementation(async(sql:any)=>sql.includes('SELECT token')?{token:'lease'}:undefined);engine={rehydrateFromMessages:vi.fn().mockResolvedValue('/native-session'),run:vi.fn(async function*(_s,_p,_o,cb){await cb.claimSessionId('/native-session');yield {type:'assistant',content:[{type:'text',text:'이어진 답변'}]};yield {type:'turn_terminal',outcome:'completed'};})};vi.mocked(getEngine).mockResolvedValue(engine);});
it('uses native Core run and persisted session path, not quickReply',async()=>{
 expect(await runSecretaryConversation(args)).toBe('이어진 답변');
 expect(engine.rehydrateFromMessages).toHaveBeenCalledWith('secretary',expect.arrayContaining([expect.objectContaining({content:[{type:'text',text:'기존 대화'}]})]),'/work');
 expect(engine.run).toHaveBeenCalledWith('secretary','이어서',expect.objectContaining({model:'preset/core',engineSessionId:'/native-session',secretaryConversation:true,rootTurnId:expect.any(String)}),expect.anything());
 expect(execute).toHaveBeenCalledWith(expect.stringContaining('secretariat_engine_state'),expect.anything());
});
it('reuses native compacted session when external context has not changed',async()=>{
 await runSecretaryConversation(args);
 const fingerprint=vi.mocked(execute).mock.calls[0][1]?.[3];
 vi.mocked(queryOne).mockImplementation(async(sql:any)=>sql.includes('SELECT token')?{token:'lease'}:{engine_path:'/compacted',fingerprint});engine.rehydrateFromMessages.mockClear();
 await runSecretaryConversation(args);
 expect(engine.rehydrateFromMessages).not.toHaveBeenCalled();
 expect(engine.run.mock.calls.at(-1)[2].engineSessionId).toBe('/compacted');
});

it('streams native text and aborts native execution on cancellation',async()=>{
 const controller=new AbortController();const onText=vi.fn();engine.abort=vi.fn();
 engine.run=vi.fn(async function*(){yield {type:'assistant',content:[{type:'text',text:'부분 답변'}]};controller.abort();yield {type:'turn_terminal',outcome:'stopped'};});
 await expect(runSecretaryConversation({...args,signal:controller.signal,onText})).rejects.toThrow('secretary_turn_failed');
 expect(onText).toHaveBeenCalledWith('부분 답변');expect(engine.abort).toHaveBeenCalledWith('secretary');
 expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM secretariat_engine_state'),[7,'secretary','lease']);
});

it('does not commit a response when transport ends without a completion verdict',async()=>{
 engine.run=vi.fn(async function*(){yield {type:'assistant',content:[{type:'text',text:'unfinished'}]};});
 await expect(runSecretaryConversation(args)).rejects.toThrow('secretary_turn_failed');
 expect(execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM secretariat_engine_state'),[7,'secretary','lease']);
});

it('rejects stale execution before opening native history',async()=>{
 vi.mocked(queryOne).mockResolvedValue(undefined);
 await expect(runSecretaryConversation(args)).rejects.toThrow('secretary_lease_lost');
 expect(engine.rehydrateFromMessages).not.toHaveBeenCalled();expect(engine.run).not.toHaveBeenCalled();
});

it('rebuilds authorized history when a persisted native file is unavailable after restart',async()=>{
 await runSecretaryConversation(args);
 const fingerprint=vi.mocked(execute).mock.calls[0][1]?.[3];
 vi.mocked(queryOne).mockImplementation(async(sql:any)=>sql.includes('SELECT token')?{token:'lease'}:{engine_path:'/missing',fingerprint});
 vi.mocked(access).mockRejectedValue(new Error('ENOENT'));engine.rehydrateFromMessages.mockClear();
 await runSecretaryConversation(args);
 expect(engine.rehydrateFromMessages).toHaveBeenCalled();
});

it('persists a root message before invoking the mandatory native turn admission',async()=>{
 await runSecretaryConversation(args);
 const options=engine.run.mock.calls[0][2];
 expect(options.rootTurnId).toBeTruthy();
 expect(registerAgentTurn).toHaveBeenCalledWith({rootTurnId:options.rootTurnId,sessionId:'secretary'});
 expect(saveMessage).toHaveBeenCalledWith('secretary',expect.objectContaining({id:options.rootTurnId,role:'user',metadata:{contextState:'secretary_internal'}}));
 expect(vi.mocked(saveMessage).mock.invocationCallOrder[0]).toBeLessThan(engine.run.mock.invocationCallOrder[0]);
});

it('never duplicates private text into generic runtime message records',async()=>{
 engine.run=vi.fn(async function*(_s,_p,_o,callbacks){
   await callbacks.saveMessage({id:'answer',role:'assistant',content:[{type:'text',text:'private source material'}],metadata:{secret:'not copied'}});
   await callbacks.updateMessageContent('answer',[{type:'text',text:'private updated material'}]);
   yield {type:'turn_terminal',outcome:'completed'};
 });
 expect(await runSecretaryConversation({...args,prompt:'private question'})).toBe('private updated material');
 expect(JSON.stringify(vi.mocked(saveMessage).mock.calls)).not.toContain('private question');
 expect(JSON.stringify(vi.mocked(saveMessage).mock.calls)).not.toContain('private source material');
 expect(JSON.stringify(vi.mocked(saveMessage).mock.calls)).not.toContain('not copied');
});
