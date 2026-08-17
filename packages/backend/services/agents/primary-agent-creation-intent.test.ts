import { beforeEach, describe, expect, it, vi } from 'vitest';
const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ queryOne }));
const { createPrimaryAgentCreationIntent, consumePrimaryAgentCreationIntent, primaryAgentStaffingHash } = await import('./primary-agent-creation-intent.js');
const payload = {
  name:'Researcher',face:'🔎',tagline:'Find evidence',role:'Research',promise:'Cited answers',instruction:'Use sources',firstMission:'Research X',
  roiContract:{primaryMetric:'accepted findings',target:'10'},capabilityRequirements:{required:['web.search'],forbidden:['project.files.write']},
  harnessBinding:{harnessId:'quick-web-research',harnessVersion:1,runtimeProfileId:'web-only',runtimeProfileVersion:1},
};
describe('Primary Agent creation intents',()=>{
  beforeEach(()=>queryOne.mockReset());
  it('issues an intent from any accessible active source Project',async()=>{
    queryOne.mockResolvedValueOnce({system_key:null}).mockResolvedValueOnce({id:'intent-1',expires_at:'later'});
    await expect(createPrimaryAgentCreationIntent({actorUserId:7,actorRole:'member',sourceProjectId:'general',payload})).resolves.toMatchObject({approvalIntentId:'intent-1',staffingHash:primaryAgentStaffingHash(payload)});
  });
  it('rejects a missing, archived, or inaccessible source Project',async()=>{
    queryOne.mockResolvedValueOnce(undefined);
    await expect(createPrimaryAgentCreationIntent({actorUserId:7,actorRole:'member',sourceProjectId:'missing',payload})).rejects.toThrow('accessible source Project');
  });
  it('hashes ROI and capability requirements as part of the complete package',()=>{
    expect(primaryAgentStaffingHash(payload)).not.toBe(primaryAgentStaffingHash({...payload,roiContract:{...payload.roiContract,target:'20'}}));
    expect(primaryAgentStaffingHash(payload)).not.toBe(primaryAgentStaffingHash({...payload,capabilityRequirements:{...payload.capabilityRequirements,required:['web.fetch']}}));
  });
  it('atomically consumes the exact actor, source and payload for one command',async()=>{
    const hash=primaryAgentStaffingHash(payload);queryOne.mockResolvedValueOnce({id:'intent-1'});
    await expect(consumePrimaryAgentCreationIntent({approvalIntentId:'intent-1',commandId:'command-1',actorUserId:7,sourceProjectId:'talent',approvedCardHash:hash,payload})).resolves.toBeUndefined();
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('consumed_by_command_id'),expect.arrayContaining(['intent-1',7,'talent',hash,'command-1']));
  });
  it('rejects a changed package or an already-consumed intent',async()=>{
    const hash=primaryAgentStaffingHash(payload);
    await expect(consumePrimaryAgentCreationIntent({approvalIntentId:'intent-1',commandId:'command-1',actorUserId:7,sourceProjectId:'talent',approvedCardHash:'0'.repeat(64),payload})).rejects.toThrow('hash does not match');
    queryOne.mockResolvedValueOnce(undefined);
    await expect(consumePrimaryAgentCreationIntent({approvalIntentId:'intent-1',commandId:'command-2',actorUserId:7,sourceProjectId:'talent',approvedCardHash:hash,payload})).rejects.toThrow('unused');
  });
});
