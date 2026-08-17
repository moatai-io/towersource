import { describe, expect, it, vi } from 'vitest';
import { processRecipientInbox } from './delivery-controller.js';

const claim = { deliveryId:'d1',messageId:'m1',recipientSessionId:'s2',ownerToken:'t1',ownerBootId:'b1',attemptCount:1,leaseUntil:'later' };
const message = { id:'m1',senderSessionId:'s1',recipientSessionId:'s2',senderUserId:1,projectId:null,kind:'request',body:{text:'x'},deliveryPolicy:'wake',priority:'normal',correlationId:'c',causationId:null,inReplyToMessageId:null,rootConversationId:'c',workerId:null,agentRunId:null,sourceRootTurnId:null,operationId:null,status:'accepted',createdAt:'now',expiresAt:null };
function deps(overrides:any={}) { return { claimNext:vi.fn().mockResolvedValue(claim),getMessage:vi.fn().mockResolvedValue(message),settleClaim:vi.fn().mockResolvedValue(true),decidePolicy:vi.fn().mockResolvedValue({action:'deliver'}),deliver:vi.fn().mockResolvedValue({status:'completed',mode:'new-turn'}),...overrides}; }

describe('recipient inbox controller',()=>{
 it('is idle without a claim',async()=>expect(processRecipientInbox({recipientSessionId:'s2',ownerBootId:'b1'},deps({claimNext:vi.fn().mockResolvedValue(undefined)}))).resolves.toEqual({outcome:'idle'}));
 it('settles store-only without invoking delivery',async()=>{const d=deps({getMessage:vi.fn().mockResolvedValue({...message,deliveryPolicy:'store-only'})});expect((await processRecipientInbox({recipientSessionId:'s2',ownerBootId:'b1'},d)).outcome).toBe('completed');expect(d.deliver).not.toHaveBeenCalled();expect(d.settleClaim).toHaveBeenCalledWith(expect.objectContaining({state:'completed',mode:'stored'}));});
 it.each([['hold','held','needs_attention'],['refuse','refused','failed']] as const)('settles %s policy',async(action,outcome,state)=>{const d=deps({decidePolicy:vi.fn().mockResolvedValue({action,reason:'policy'})});expect((await processRecipientInbox({recipientSessionId:'s2',ownerBootId:'b1'},d)).outcome).toBe(outcome);expect(d.settleClaim).toHaveBeenCalledWith(expect.objectContaining({state}));});
 it('reschedules thrown delivery errors',async()=>{const d=deps({deliver:vi.fn().mockRejectedValue(new Error('busy'))});expect((await processRecipientInbox({recipientSessionId:'s2',ownerBootId:'b1'},d)).outcome).toBe('retry_wait');expect(d.settleClaim).toHaveBeenCalledWith(expect.objectContaining({state:'retry_wait',error:'busy'}));});
 it('reports claim_lost when fencing rejects settlement',async()=>{const d=deps({settleClaim:vi.fn().mockResolvedValue(false)});expect((await processRecipientInbox({recipientSessionId:'s2',ownerBootId:'b1'},d)).outcome).toBe('claim_lost');});
});
