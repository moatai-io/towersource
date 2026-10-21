import { beforeEach, describe, expect, it, vi } from 'vitest';
const queryOne=vi.fn();
vi.mock('../../db/pg-repo.js',()=>({queryOne}));
const {buildPrimaryAgentBootstrapPayload,loadPrimaryAgentBootstrapPayload}=await import('./primary-agent-bootstrap.js');

describe('Primary Agent bootstrap staffing',()=>{
  beforeEach(()=>queryOne.mockReset());
  it('expands minimal input with the server-owned broad default exact tuple',async()=>{
    queryOne.mockResolvedValueOnce({harness_id:'tower-default',harness_version:1,runtime_profile_id:'standard',runtime_profile_version:1,staffing_capability_ids:['project_file_write','public_web_research','project_file_write']});
    const first=await buildPrimaryAgentBootstrapPayload({name:'새 팀원',face:'🤖',expertiseIntent:' 복잡한 자료에서 핵심 찾기 '});
    queryOne.mockResolvedValueOnce({harness_id:'tower-default',harness_version:1,runtime_profile_id:'standard',runtime_profile_version:1,staffing_capability_ids:['project_file_write','public_web_research','project_file_write']});
    const second=await buildPrimaryAgentBootstrapPayload({name:'새 팀원',face:'🤖',expertiseIntent:'복잡한 자료에서 핵심 찾기'});
    expect(first.payload).toEqual(second.payload);
    expect(first.payload).toMatchObject({creationMode:'bootstrap',sourceExpertiseIntent:'복잡한 자료에서 핵심 찾기',harnessBinding:{harnessId:'tower-default',harnessVersion:1,runtimeProfileId:'standard',runtimeProfileVersion:1},capabilityRequirements:{required:['project_file_write','public_web_research']}});
    expect(first.payload.role).toContain('사용자의 실제 업무를 수행');
    expect(first.payload.instruction).toContain('이미 받은 정보를 다시 묻지 말고 사용자가 맡긴 업무를 온보딩보다 우선하세요');
    expect(first.payload.instruction).toContain('시스템 지침을 따르세요');
    expect(first.payload.promise).toContain('일의 이유를 먼저 배우고');
    expect(first.payload.firstMission).toBe('첫 질문으로 업무 목적을 배우고 프로젝트의 업무 기반을 정립하기');
    expect(first.card.profileStatus).toBe('ready');
    expect(queryOne.mock.calls[0][0]).toContain("rp.profile_id='standard'");
    expect(queryOne.mock.calls[0][0]).toContain('v.staffing_capability_ids');
  });
  it('rejects missing minimal fields and an unavailable default',async()=>{
    await expect(buildPrimaryAgentBootstrapPayload({name:' ',face:'🤖',expertiseIntent:'정리'})).rejects.toThrow('name is required');
    queryOne.mockResolvedValueOnce(undefined);
    await expect(buildPrimaryAgentBootstrapPayload({name:'팀원',face:'🤖',expertiseIntent:'정리'})).rejects.toThrow('Default Primary Agent Harness is unavailable');
  });
  it('loads an unused bootstrap intent or the same consumed idempotent command',async()=>{
    const input={approvalIntentId:'intent',actorUserId:7,sourceProjectId:'talent',staffingHash:'a'.repeat(64),idempotencyKey:'agent-bootstrap:hash'};
    queryOne.mockResolvedValueOnce({staffing_payload:{creationMode:'bootstrap',name:'팀원'}});
    await expect(loadPrimaryAgentBootstrapPayload(input)).resolves.toMatchObject({creationMode:'bootstrap'});
    expect(queryOne.mock.calls[0][0]).toContain('c.idempotency_key=$5');
    expect(queryOne.mock.calls[0][1]).toEqual(['intent',7,'talent','a'.repeat(64),'agent-bootstrap:hash']);
    queryOne.mockResolvedValueOnce({staffing_payload:{name:'staffed'}});
    await expect(loadPrimaryAgentBootstrapPayload(input)).rejects.toThrow('bootstrap intent required');
  });
});
