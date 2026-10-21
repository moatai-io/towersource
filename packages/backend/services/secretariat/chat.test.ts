vi.mock('./reading-context.js',()=>({readParticipatingContext:vi.fn().mockResolvedValue([])}));
import {readParticipatingContext} from './reading-context.js';
vi.mock('./conversation-runtime.js',()=>({runSecretaryConversation:vi.fn()}));
import {runSecretaryConversation} from './conversation-runtime.js';
vi.mock('./personal-session.js',()=>({ensurePersonalSecretarySession:vi.fn().mockResolvedValue('secretary')}));
import { beforeEach,expect,it,vi } from 'vitest';
vi.mock('../../db/pg-repo.js',()=>({query:vi.fn(),queryOne:vi.fn(),execute:vi.fn()}));
vi.mock('./service.js',()=>({secretariatService:{inbox:vi.fn()}}));
vi.mock('./store.js',()=>({secretariatStore:{candidates:vi.fn()}}));
vi.mock('./provider.js',()=>({prepareProviders:vi.fn(),safeCandidate:()=>true}));
vi.mock('../pm/project-access.js',()=>({canAccessSession:vi.fn()}));
vi.mock('../pm/project-membership-manager.js',()=>({isProjectMember:vi.fn()}));
import {query,queryOne,execute} from '../../db/pg-repo.js';
import {secretariatService} from './service.js';
import {secretariatStore} from './store.js';
import {prepareProviders} from './provider.js';
import {canAccessSession} from '../pm/project-access.js';
import {isProjectMember} from '../pm/project-membership-manager.js';
import {chatHistory,chatReply} from './chat.js';
beforeEach(()=>{vi.resetAllMocks();vi.mocked(readParticipatingContext).mockResolvedValue([]);vi.mocked(execute).mockResolvedValue({changes:1} as any);vi.mocked(runSecretaryConversation).mockResolvedValue('함께 확인해요.');vi.mocked(query).mockResolvedValue([]);vi.mocked(queryOne).mockResolvedValue({token:'t'});vi.mocked(secretariatService.inbox).mockResolvedValue({proposals:[]} as any);vi.mocked(secretariatStore.candidates).mockResolvedValue([{projectId:'p',sessionId:'s'}] as any);vi.mocked(isProjectMember).mockResolvedValue(true);vi.mocked(canAccessSession).mockResolvedValue({allowed:true});});
it('does not expose history after source access revocation',async()=>{vi.mocked(query).mockResolvedValue([{id:'x',project_id:'p',session_id:'s',body:'private'}]);vi.mocked(canAccessSession).mockResolvedValue({allowed:false,status:403,message:'denied'});expect((await chatHistory(7)).messages).toEqual([]);expect(query).toHaveBeenCalledWith(expect.stringContaining('user_id=$1'),[7]);});
it('blocks overlapping calls before provider invocation',async()=>{vi.mocked(queryOne).mockResolvedValue(undefined);await expect(chatReply(7,'안녕')).rejects.toThrow('chat_busy');expect(prepareProviders).not.toHaveBeenCalled();});
it('stores owner-scoped reply only after authorization',async()=>{vi.mocked(prepareProviders).mockResolvedValue({chat:vi.fn().mockResolvedValue('함께 확인해요.')} as any);await chatReply(7,'검토해줘');expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO secretariat_chat_messages'),expect.arrayContaining([7,'검토해줘','함께 확인해요.',null,null]));});

it('new proposals do not silently change the conversational subject', async()=>{
  vi.mocked(query).mockResolvedValue([{id:'old',role:'user',body:'previous',project_id:'p',session_id:'s'}]);
  vi.mocked(secretariatService.inbox).mockResolvedValue({proposals:[{id:'new',projectId:'other',sessionId:'other'}]} as any);
  const chat=vi.fn().mockResolvedValue('이어갈게요.');vi.mocked(prepareProviders).mockResolvedValue({chat} as any);
  await chatReply(7,'이어서');expect(runSecretaryConversation).toHaveBeenCalledWith(expect.objectContaining({userId:7}));
  expect(vi.mocked(runSecretaryConversation).mock.calls[0][0].history).toEqual(expect.arrayContaining([expect.objectContaining({body:'previous'})]));
});
it('allows a general conversation with no work candidates',async()=>{
  vi.mocked(prepareProviders).mockResolvedValue({chat:vi.fn().mockResolvedValue('안녕하세요.')} as any);
  await chatReply(7,'안녕',null);expect(runSecretaryConversation).toHaveBeenCalled();
});
it('rejects an inaccessible explicitly selected proposal before inference',async()=>{
  await expect(chatReply(7,'이거 봐줘','missing')).rejects.toThrow('chat_no_context');expect(prepareProviders).not.toHaveBeenCalled();
});

it('retains earlier subjects while continuing one conversation',async()=>{
 vi.mocked(query).mockResolvedValue([{id:'a',role:'user',body:'earlier subject',project_id:null,session_id:null},{id:'b',role:'assistant',body:'later subject',project_id:null,session_id:null}]);
 const chat=vi.fn().mockResolvedValue('기억합니다.');vi.mocked(prepareProviders).mockResolvedValue({chat} as any);
 await chatReply(7,'아까 말한 건?');
 expect(vi.mocked(runSecretaryConversation).mock.calls[0][0].history).toEqual(expect.arrayContaining([expect.objectContaining({role:'user',body:'earlier subject'}),expect.objectContaining({role:'assistant',body:'later subject'})]));
});
it('hides replies derived from a revoked additional source',async()=>{
 vi.mocked(query).mockResolvedValue([{id:'a',role:'assistant',body:'derived',project_id:null,session_id:null,source_refs:[{projectId:'revoked',sessionId:'s'}]}]);
 vi.mocked(isProjectMember).mockResolvedValue(false);expect((await chatHistory(7)).messages).toEqual([]);
});

it('rejects a stale lease without claiming a completed persisted answer',async()=>{
 vi.mocked(execute).mockImplementation(async(sql:any)=>({changes:sql.includes('WITH lease AS')?0:1}) as any);
 await expect(chatReply(7,'이어서')).rejects.toThrow('secretary_lease_lost');
 expect(execute).toHaveBeenCalledWith(expect.stringContaining('token=$10'),expect.anything());
});
it('refuses duplicate request identity before model execution',async()=>{
 vi.mocked(execute).mockImplementation(async(sql:any)=>({changes:sql.includes('INSERT INTO secretariat_conversation_turns')?0:1}) as any);
 await expect(chatReply(7,'요청',undefined,{requestId:'dedup'})).rejects.toThrow('secretary_request_exists');
 expect(runSecretaryConversation).not.toHaveBeenCalled();
});

it('checks repeated sources once per read but refreshes permissions on the next read',async()=>{
 const rows=Array.from({length:12},(_,i)=>({id:String(i),role:'assistant',body:'text',project_id:'p',session_id:'s',source_refs:[{projectId:'p',sessionId:'s'}]}));
 vi.mocked(query).mockImplementation(async()=>[...rows]);
 expect((await chatHistory(7)).messages).toHaveLength(12);
 expect(isProjectMember).toHaveBeenCalledTimes(1);expect(canAccessSession).toHaveBeenCalledTimes(1);
 vi.mocked(canAccessSession).mockResolvedValue({allowed:false,status:403,message:'revoked'});
 expect((await chatHistory(7)).messages).toHaveLength(0);
 expect(canAccessSession).toHaveBeenCalledTimes(2);
});

it('includes authorized recent-session excerpts and retains their source references',async()=>{
 vi.mocked(readParticipatingContext).mockResolvedValue([{projectId:'p',sessionId:'s',title:'work',updatedAt:'now',messages:[{role:'user',text:'actual context'}]}]);
 await chatReply(7,'하던 일은?');
 expect(JSON.stringify(vi.mocked(runSecretaryConversation).mock.calls)).toContain('actual context');
 expect(execute).toHaveBeenCalledWith(expect.stringContaining('WITH lease'),expect.arrayContaining([expect.stringContaining('"sessionId":"s"')]));
});
