import { beforeEach, describe, expect, it, vi } from 'vitest';
const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js',()=>({queryOne}));
const { validatePrimaryAgentHarnessBinding } = await import('./primary-agent-staffing.js');
const binding={harnessId:'quick-web-research',harnessVersion:1,runtimeProfileId:'web-only',runtimeProfileVersion:1};
describe('Primary Agent Harness binding validation',()=>{
  beforeEach(()=>queryOne.mockReset());
  it('accepts an accessible published tuple with exact capabilities',async()=>{
    queryOne.mockResolvedValueOnce({name:'Quick Web Research',engine:'pi',staffing_capability_ids:['web.fetch','web.search']});
    await expect(validatePrimaryAgentHarnessBinding({sourceProjectId:'talent',binding,requirements:{required:['web.search'],forbidden:['project.files.write']}})).resolves.toMatchObject({engine:'pi',providedCapabilities:['web.fetch','web.search']});
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("h.visibility='system' OR h.owner_project_id=$5"),[binding.harnessId,1,binding.runtimeProfileId,1,'talent']);
    expect(queryOne.mock.calls[0][0]).toContain('v.staffing_capability_ids');
    expect(queryOne.mock.calls[0][0]).not.toContain('v.effective_manifest');
  });
  it('rejects an unavailable or inaccessible tuple',async()=>{
    queryOne.mockResolvedValueOnce(undefined);
    await expect(validatePrimaryAgentHarnessBinding({sourceProjectId:'talent',binding,requirements:{required:[]}})).rejects.toThrow('unavailable');
  });
  it('rejects missing required and present forbidden capabilities',async()=>{
    queryOne.mockResolvedValueOnce({name:'Bad',engine:'pi',staffing_capability_ids:['project.files.write']});
    await expect(validatePrimaryAgentHarnessBinding({sourceProjectId:'talent',binding,requirements:{required:['web.search'],forbidden:['project.files.write']}})).rejects.toMatchObject({message:'Harness capability mismatch',details:{missingRequired:['web.search'],forbiddenPresent:['project.files.write']}});
  });
});
