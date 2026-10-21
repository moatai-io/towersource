import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({send:vi.fn(),spawn:vi.fn()}));
vi.mock('./spawn-rpc.js',()=>({sendToSession:mocks.send,spawnChildSession:mocks.spawn}));
import {sendSessionConversationMessage} from './session-conversation-service.js';
beforeEach(()=>{mocks.send.mockReset();mocks.send.mockResolvedValue({ok:true});});
it('routes a C to B request with C as reply/wake recipient, not A',async()=>{
 await sendSessionConversationMessage({sourceSessionId:'C',sourceSessionName:'Reviewer',sourceUserId:7,targetSessionId:'B',message:'Please check this mismatch',onComplete:'wake'});
 expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({callerSessionId:'C',targetSessionId:'B',callerUserId:7,callerRole:'member',onComplete:'wake'}));
});
it('permits reverse addressing without changing identity or authority',async()=>{
 await sendSessionConversationMessage({sourceSessionId:'B',sourceUserId:7,targetSessionId:'C',message:'Here is the evidence',onComplete:'wake'});
 expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({callerSessionId:'B',targetSessionId:'C',callerRole:'member'}));
});
it.each(['SEND_PERMISSION_DENIED','TARGET_STREAMING','SEND_LOOP','SEND_RATE_LIMIT'])('propagates %s without retry or rerouting',async code=>{
 mocks.send.mockRejectedValue(Object.assign(new Error(code),{code}));
 await expect(sendSessionConversationMessage({sourceSessionId:'C',sourceUserId:7,targetSessionId:'B',message:'question',onComplete:'wake'})).rejects.toThrow(code);
 expect(mocks.send).toHaveBeenCalledTimes(1);expect(mocks.spawn).not.toHaveBeenCalled();
});
