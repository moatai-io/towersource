import { afterEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const processRecipientInbox = vi.fn();
const quarantineClaimsFromPreviousBoot = vi.fn();
vi.mock('../../db/pg-repo.js',()=>({query}));
vi.mock('../../config.js',()=>({config:{serverEpoch:'boot-new'}}));
vi.mock('./delivery-controller.js',()=>({processRecipientInbox}));
vi.mock('./delivery-lease-store.js',()=>({quarantineClaimsFromPreviousBoot}));
const {startDeliveryPump,stopDeliveryPump,notifyRecipientInbox}=await import('./delivery-pump.js');

describe('delivery pump',()=>{
 afterEach(()=>{stopDeliveryPump();vi.clearAllMocks();});
 it('quarantines previous-boot claims and sweeps due recipients at startup',async()=>{quarantineClaimsFromPreviousBoot.mockResolvedValue(2);query.mockResolvedValue([{recipient_session_id:'s1'}]);processRecipientInbox.mockResolvedValue({outcome:'idle'});await startDeliveryPump({dependencies:{},intervalMs:60_000});expect(quarantineClaimsFromPreviousBoot).toHaveBeenCalledWith('boot-new');expect(processRecipientInbox).toHaveBeenCalledWith(expect.objectContaining({recipientSessionId:'s1',ownerBootId:'boot-new'}),expect.any(Object));});
 it('drains multiple deliveries and stops on idle',async()=>{quarantineClaimsFromPreviousBoot.mockResolvedValue(0);query.mockResolvedValue([]);processRecipientInbox.mockResolvedValueOnce({outcome:'completed'}).mockResolvedValueOnce({outcome:'idle'});await startDeliveryPump({dependencies:{},intervalMs:60_000});notifyRecipientInbox('s2');await vi.waitFor(()=>expect(processRecipientInbox).toHaveBeenCalledTimes(2));});
 it('serializes concurrent doorbells for the same recipient',async()=>{quarantineClaimsFromPreviousBoot.mockResolvedValue(0);query.mockResolvedValue([]);let release!:()=>void;processRecipientInbox.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({outcome:'idle'});}));await startDeliveryPump({dependencies:{},intervalMs:60_000});notifyRecipientInbox('s3');notifyRecipientInbox('s3');await vi.waitFor(()=>expect(processRecipientInbox).toHaveBeenCalledTimes(1));release();});
});
