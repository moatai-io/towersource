import { resolveOperatorSkillAssets } from '../skill/operator-skill-assets.js';
import { resolveRegistrySkillBundle } from '../skill/skill-bundle-resolver.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {resolveProjectCredentialSecretValue,resolveRuntimeBoxApiKeyEnv,resolveRuntimeBoxCredentialFileMaterialization} from '../credential-vault/credential-vault-service.js';
import {selectProjectGwsConnection} from './runtime-box-manager.js';
import {resolveGatewayApiClient} from '../gateway-profile/gateway-profile-client.js';
import {declaredManagedSkillCredentialEnvNames,requestedCredentialEnvNames,resolveRemoteWorkbenchCredentialEnv} from './workbench-remote-credential-resolution.js';
vi.mock('../credential-vault/credential-vault-service.js',()=>({diagnoseUnresolvedCredentialRequirements:vi.fn(async (_projectId: string, names: string[]) => names.map(envName => ({envName, reason:'NoAccessibleMatchingCredential'}))),resolveProjectCredentialSecretValue:vi.fn(),resolveRuntimeBoxApiKeyEnv:vi.fn(),resolveRuntimeBoxCredentialFileMaterialization:vi.fn()}));
vi.mock('../gateway-profile/gateway-profile-client.js',()=>({resolveGatewayApiClient:vi.fn()}));
vi.mock('./runtime-box-manager.js',async importOriginal=>({
 ...await importOriginal<typeof import('./runtime-box-manager.js')>(),
 commandRequestsGwsConnectionId:vi.fn(()=>null),selectProjectGwsConnection:vi.fn(),
}));
beforeEach(()=>{
 vi.clearAllMocks();
 vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({env:{OPENAI_API_KEY:'openai',NAVER_CLIENT_ID:'naver'},injected:[],skippedExisting:[],skipped:[]} as any);
 vi.mocked(resolveRuntimeBoxCredentialFileMaterialization).mockResolvedValue({materialize:[],skipped:[]} as any);
 vi.mocked(resolveGatewayApiClient).mockResolvedValue({profileId:'tower-shared-api-v1',apiId:'openai-image',baseUrl:'https://gateway.example.com/openai',apiKey:'zuplo-virtual-key',credentialId:'zuplo-key',readiness:'ready'});
});
describe('Remote Workbench Credential resolution',()=>{
 it.each([
  {command:'GWS_PROFILE=personal gws gmail users getProfile'},
  {command:'TOWER_GWS_PROFILE="personal" gws auth status'},
  {command:'gws auth login'},
  {command:'gws auth status',env:{GWS_PROFILE:'personal'}},
  {command:'gws auth status',env:{TOWER_GWS_PROFILE:'personal'}},
 ])('rejects retired personal/login intent without silently using the Agent account: %j',async request=>{
  await expect(resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request})).rejects.toThrow('AGENT_GWS_CONNECTION_REQUIRED');
  expect(selectProjectGwsConnection).not.toHaveBeenCalled();
  expect(resolveProjectCredentialSecretValue).not.toHaveBeenCalled();
  expect(resolveRuntimeBoxApiKeyEnv).not.toHaveBeenCalled();
 });
 it.each([
  {command:'GWS_PROFILE=finance gws auth status'},
  {command:'gws auth status',env:{TOWER_GWS_PROFILE:'finance'}},
 ])('never substitutes the default account for a legacy finance request: %j',async request=>{
  await expect(resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request})).rejects.toThrow('AGENT_GWS_EXPLICIT_CONNECTION_REQUIRED');
  expect(selectProjectGwsConnection).not.toHaveBeenCalled();
  expect(resolveProjectCredentialSecretValue).not.toHaveBeenCalled();
 });
 it.each([
  ['.tower/skills/image-gen/scripts/generate_image.py', undefined, true],
  ['./.tower/skills/image-gen/scripts/generate_image.py', undefined, true],
  ['../.tower/skills/image-gen/scripts/generate_image.py', 'work', true],
  ['.tower/skills/image-gen/scripts/generate_image.py', 'work', false],
  ['other/.tower/skills/image-gen/scripts/generate_image.py', undefined, false],
  ['.tower/skills/image-gen-extra/scripts/generate_image.py', undefined, false],
 ])('resolves mounted relative Gateway path %s (cwd %s)',async(script,subdir,matched)=>{
  const project=await fs.mkdtemp(path.join(os.tmpdir(),'gateway-relative-'));
  try {
   await fs.mkdir(path.join(project,'.tower','skills'),{recursive:true});
   await fs.writeFile(path.join(project,'.tower','skills','manifest.json'),JSON.stringify({schemaVersion:3,managedBy:'tower-project-skill-runtime-layer',skills:[{name:'image-gen',runtimePath:'/workspace/.tower/skills/image-gen',gatewayApis:[{apiId:'openai-image',apiKeyEnv:'OPENAI_IMAGE_API_KEY',baseUrlEnv:'OPENAI_IMAGE_BASE_URL'}]}]}));
   vi.mocked(resolveGatewayApiClient).mockResolvedValue({apiKey:'fixture-gateway',baseUrl:'https://example.test/openai',credentialId:'gateway'} as any);
   const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,projectRoot:project,request:{command:`work/image-gen-venv/bin/python ${script} brief.json`,cwd:subdir?path.join(project,subdir):project}});
   if(matched) expect(result.request.env).toMatchObject({OPENAI_IMAGE_API_KEY:'fixture-gateway',OPENAI_IMAGE_BASE_URL:'https://example.test/openai'});
   else expect(resolveGatewayApiClient).not.toHaveBeenCalled();
  } finally {await fs.rm(project,{recursive:true,force:true});}
 });
 it.each([
  [['OPENAI_IMAGE_API_KEY','OPENAI_IMAGE_BASE_URL'], true],
  [['OPENAI_IMAGE_BASE_URL'], true],
  [['OPENAI_IMAGE_API_KEY'], true],
  [['OPENAI_IMAGE'], false],
  [[], false],
 ])('resolves exact declared Gateway requirements %j without a skill path',async(requirements,matched)=>{
  const project=await fs.mkdtemp(path.join(os.tmpdir(),'gateway-declared-'));
  try {
   await fs.mkdir(path.join(project,'.tower','skills'),{recursive:true});
   await fs.writeFile(path.join(project,'.tower','skills','manifest.json'),JSON.stringify({schemaVersion:3,managedBy:'tower-project-skill-runtime-layer',skills:[{name:'image-gen',runtimePath:'/workspace/.tower/skills/image-gen',gatewayApis:[{apiId:'openai-image',apiKeyEnv:'OPENAI_IMAGE_API_KEY',baseUrlEnv:'OPENAI_IMAGE_BASE_URL'}]}]}));
   vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({env:{OPENAI_IMAGE_API_KEY:'fixture-direct-key'},injected:[],skippedExisting:[],skipped:[]} as any);
   vi.mocked(resolveGatewayApiClient).mockResolvedValue({apiKey:'fixture-gateway',baseUrl:'https://example.test/openai',credentialId:'gateway'} as any);
   const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,projectRoot:project,request:{command:"python3 - <<'PY'\nimport os\nprint(bool(os.getenv('OPENAI_IMAGE_BASE_URL')))\nPY",credentialRequirements:requirements}});
   if(matched){
    expect(resolveGatewayApiClient).toHaveBeenCalledWith({actorUserId:7,projectId:'p',apiId:'openai-image'});
    expect(result.request.env).toMatchObject({OPENAI_IMAGE_API_KEY:'fixture-gateway',OPENAI_IMAGE_BASE_URL:'https://example.test/openai'});
   }else expect(resolveGatewayApiClient).not.toHaveBeenCalled();
  } finally {await fs.rm(project,{recursive:true,force:true});}
 });
 it('gives a generic wrapper the same exact requested credential as direct execution',async()=>{
  const wrapper=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'python work/run.py',credentialRequirements:['NAVER_CLIENT_ID']}});
  const direct=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'python work/run.py --key "$NAVER_CLIENT_ID"'}});
  expect(wrapper.request.env).toEqual(direct.request.env);
  expect(wrapper.request.env).toEqual({NAVER_CLIENT_ID:'naver'});
  expect(resolveRuntimeBoxApiKeyEnv).toHaveBeenCalledWith(expect.objectContaining({projectId:'p',userId:7,requestedEnvNames:new Set(['NAVER_CLIENT_ID'])}));
 });
 it('keeps suppression above explicit requirements',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'npm install && node work/run.js',credentialRequirements:['NAVER_CLIENT_ID']}});
  expect(result.suppressed).toBe(true);
  expect(resolveRuntimeBoxApiKeyEnv).not.toHaveBeenCalled();
 });
 it('removes caller-controlled GWS envelopes even when credential resolution is suppressed',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'printenv',env:{SAFE:'kept',TOWER_REMOTE_GWS_CONFIG_B64:'caller-bundle',TOWER_REMOTE_GWS_USER_ID:'7'}}});
  expect(result.suppressed).toBe(true);
  expect(result.request.env).toEqual({SAFE:'kept'});
  expect(result.environmentKeys).toEqual(['SAFE']);
  expect(resolveProjectCredentialSecretValue).not.toHaveBeenCalled();
 });
 it('does not manufacture credentials when Vault resolution provides none',async()=>{
  vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({env:{},injected:[],skippedExisting:[],skipped:[]} as any);
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'make publish',credentialRequirements:['NAVER_CLIENT_ID']}});
  expect(result.request.env).toEqual({});
 });
 it.each([{requirements:['OPENAI_']},{requirements:['bad-name']},{requirements:Array(33).fill('API_KEY')}])('rejects invalid or prefix requirements %j',async ({requirements})=>{
  await expect(resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'make publish',credentialRequirements:requirements}})).rejects.toThrow('WORKBENCH_CREDENTIAL_REQUIREMENTS_INVALID');
 });
 it('selects an explicitly requested GWS connection for an indirect wrapper',async()=>{
  vi.mocked(selectProjectGwsConnection).mockResolvedValue({id:'gws-work',displayName:'Work',isProjectDefault:true});
  vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({value:'synthetic-bundle',credentialId:'gws-work'});
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'python work/report.py',gwsConnectionId:'gws-work'}});
  expect(selectProjectGwsConnection).toHaveBeenCalledWith({projectId:'p',requestedCredentialId:'gws-work'});
  expect(result.selectedBundles).toEqual([{credentialId:'gws-work',provider:'google'}]);
  expect(resolveProjectCredentialSecretValue).toHaveBeenCalledWith(expect.objectContaining({projectId:'p',userId:7,credentialId:'gws-work'}));
 });
 it('does not bypass suppression for an explicit GWS connection',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'pip install example',gwsConnectionId:'gws-work'}});
  expect(result.suppressed).toBe(true);
  expect(selectProjectGwsConnection).not.toHaveBeenCalled();
 });
 it('propagates a connection selection rejection without creating a bundle',async()=>{
  vi.mocked(selectProjectGwsConnection).mockRejectedValue(new Error('PROJECT_CONNECTION_DENIED'));
  await expect(resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'make report',gwsConnectionId:'gws-other'}})).rejects.toThrow('PROJECT_CONNECTION_DENIED');
  expect(resolveProjectCredentialSecretValue).not.toHaveBeenCalled();
 });
 it('injects no unrelated Vault Credentials for an ordinary toolchain command',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'typst --version; pandoc --version',env:{CALLER:'kept'}}});
  expect(result).toMatchObject({request:{env:{CALLER:'kept'}},environmentKeys:['CALLER'],suppressed:false});
 });
 it('selects only the provider scope explicitly named by the command',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'python work/openai_image.py'}});
  expect(result.request.env).toEqual({OPENAI_API_KEY:'openai'});
  expect(result.environmentKeys).toEqual(['OPENAI_API_KEY']);
 });
 it('selects Credentials declared by a schema v3 managed skill without command env-name hints',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tower-managed-skill-credential-'));
  await fs.mkdir(path.join(root,'.tower','skills'),{recursive:true});
  await fs.writeFile(path.join(root,'.tower','skills','manifest.json'),JSON.stringify({schemaVersion:3,managedBy:'tower-project-skill-runtime-layer',skills:[{name:'image-gen',runtimePath:'/workspace/.tower/skills/image-gen',requiredSecrets:['OPENAI_API_KEY']}]}));
  expect(await declaredManagedSkillCredentialEnvNames(root,'python /workspace/.tower/skills/image-gen/scripts/generate_image.py brief.json')).toEqual(new Set(['OPENAI_API_KEY']));
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,projectRoot:root,request:{command:'python /workspace/.tower/skills/image-gen/scripts/generate_image.py brief.json'}});
  expect(result.request.env).toEqual({OPENAI_API_KEY:'openai'});
 });
 it('materializes Project-authorized Gateway aliases declared by a managed skill',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tower-managed-skill-gateway-'));
  await fs.mkdir(path.join(root,'.tower','skills'),{recursive:true});
  await fs.writeFile(path.join(root,'.tower','skills','manifest.json'),JSON.stringify({schemaVersion:3,managedBy:'tower-project-skill-runtime-layer',skills:[{name:'image-gen',runtimePath:'/workspace/.tower/skills/image-gen',requiredSecrets:[],gatewayApis:[{apiId:'openai-image',apiKeyEnv:'OPENAI_IMAGE_API_KEY',baseUrlEnv:'OPENAI_IMAGE_BASE_URL'}]}]}));
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,projectRoot:root,request:{command:'python /workspace/.tower/skills/image-gen/scripts/generate_image.py brief.json'}});
  expect(result.request.env).toMatchObject({OPENAI_IMAGE_API_KEY:'zuplo-virtual-key',OPENAI_IMAGE_BASE_URL:'https://gateway.example.com/openai'});
  expect(result.selectedBundles).toEqual([{credentialId:'zuplo-key',provider:'gateway:openai-image'}]);
  expect(resolveGatewayApiClient).toHaveBeenCalledWith({actorUserId:7,projectId:'p',apiId:'openai-image'});
 });
 it('keeps Gateway aliases for verified host snapshots but rejects tampered and cross-project paths',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tower-host-skill-gateway-'));
  const org=path.join(root,'org'); const project=path.join(root,'project');
  vi.stubEnv('TEAMSKILLS_PROJECT_ROOT',org);
  try {
   const source=path.join(org,'skills/image-gen'); await fs.mkdir(path.join(source,'scripts'),{recursive:true});
   await fs.writeFile(path.join(source,'SKILL.md'),'# image');
   await fs.writeFile(path.join(source,'scripts/generate.py'),'print("fixture")');
   const bundle=resolveRegistrySkillBundle('image-gen')!;
   await fs.mkdir(path.join(project,'.tower/skills'),{recursive:true});
   await fs.writeFile(path.join(project,'.tower/skills/manifest.json'),JSON.stringify({schemaVersion:3,managedBy:'tower-project-skill-runtime-layer',skills:[{name:'image-gen',sourceKind:'teamskills',canonicalId:bundle.canonicalId,bundleDigest:bundle.bundleDigest,runtimePath:'/workspace/.tower/skills/image-gen',requiredSecrets:['FIXTURE_KEY'],gatewayApis:[{apiId:'openai-image',apiKeyEnv:'OPENAI_IMAGE_API_KEY',baseUrlEnv:'OPENAI_IMAGE_BASE_URL'}]}]}));
   const asset=resolveOperatorSkillAssets(project,'image-gen','# image');
   if(asset.status!=='source-verified')throw new Error('snapshot blocked');
   const command=`python "${asset.executionDirectory}/scripts/generate.py"`;
   const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,projectRoot:project,request:{command}});
   expect(result.request.env).toMatchObject({OPENAI_IMAGE_API_KEY:'zuplo-virtual-key',OPENAI_IMAGE_BASE_URL:'https://gateway.example.com/openai'});
   expect(await declaredManagedSkillCredentialEnvNames(project,command)).toContain('FIXTURE_KEY');
   for (const prefix of [path.relative(project,asset.executionDirectory), './'+path.relative(project,asset.executionDirectory)]) {
    const relativeCommand=`PYTHONDONTWRITEBYTECODE=1 work/test/.venv/bin/python ${prefix}/scripts/generate.py brief.json --quality high`;
    const relativeResult=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,projectRoot:project,request:{command:relativeCommand,cwd:project}});
    expect(relativeResult.request.env).toMatchObject({OPENAI_IMAGE_API_KEY:'zuplo-virtual-key',OPENAI_IMAGE_BASE_URL:'https://gateway.example.com/openai'});
   }
   const subdir=path.join(project,'work');
   const subCommand=`python ${path.relative(subdir,asset.executionDirectory)}/scripts/generate.py`;
   expect(await declaredManagedSkillCredentialEnvNames(project,subCommand,subdir)).toContain('FIXTURE_KEY');
   expect(await declaredManagedSkillCredentialEnvNames(project,`python other/${path.relative(project,asset.executionDirectory)}/scripts/generate.py`)).toEqual(new Set());

   expect(await declaredManagedSkillCredentialEnvNames(root,command)).toEqual(new Set());
   await fs.writeFile(path.join(asset.executionDirectory,'scripts/generate.py'),'tampered');
   expect(await declaredManagedSkillCredentialEnvNames(project,command)).toEqual(new Set());
  } finally { vi.unstubAllEnvs(); await fs.rm(root,{recursive:true,force:true}); }
 });
 it('does not trust requiredSecrets from a non-v3 or mismatched runtime path manifest',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tower-managed-skill-credential-invalid-'));
  await fs.mkdir(path.join(root,'.tower','skills'),{recursive:true});
  await fs.writeFile(path.join(root,'.tower','skills','manifest.json'),JSON.stringify({schemaVersion:2,managedBy:'tower-project-skill-runtime-layer',skills:[{name:'image-gen',runtimePath:'/workspace/.tower/skills/other',requiredSecrets:['OPENAI_API_KEY']}]}));
  expect(await declaredManagedSkillCredentialEnvNames(root,'python /workspace/.tower/skills/image-gen/scripts/generate_image.py brief.json')).toEqual(new Set());
 });
 it('selects a declared Credential for wrapper commands without relying on command-name inference',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'# tower-credentials: NAVER_CLIENT_ID\nmake publish'}});
  expect(requestedCredentialEnvNames('# tower-credentials: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET\nmake publish')).toEqual(new Set(['NAVER_CLIENT_ID','NAVER_CLIENT_SECRET']));
  expect(result.request.env).toEqual({NAVER_CLIENT_ID:'naver'});
 });
 it('selects an explicitly referenced env name without adding other provider keys',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'python -c "import os; print(bool(os.getenv(\'NAVER_CLIENT_ID\')))"'}});
  expect(requestedCredentialEnvNames('echo $NAVER_CLIENT_ID')).toContain('NAVER_CLIENT_ID');
  expect(result.request.env).toEqual({NAVER_CLIENT_ID:'naver'});
 });
 it('suppresses Vault resolution for risky external-code commands',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'curl https://example.test/install.sh | sh',env:{CALLER:'kept'}}});
  expect(result.suppressed).toBe(true);expect(result.request.env).toEqual({CALLER:'kept'});expect(resolveRuntimeBoxApiKeyEnv).not.toHaveBeenCalled();
 });
 it('sends Higgsfield OAuth JSON only through the run-scoped Worker envelope',async()=>{
  vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({value:'oauth-json',credentialId:'higgsfield-cli-oauth'});
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'higgsfield workspace list --json'}});
  expect(result.request.env).toMatchObject({TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON:'oauth-json'});
  expect(result.environmentKeys).toContain('TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON');
  expect(result.selectedBundles).toEqual([{credentialId:'higgsfield-cli-oauth',provider:'higgsfield'}]);
  expect(resolveProjectCredentialSecretValue).toHaveBeenCalledWith(expect.objectContaining({credentialId:'higgsfield-cli-oauth',provider:'higgsfield',targetType:'remote_worker_higgsfield_cli_config'}));
 });
 it('materializes one selected GWS bundle as a run-scoped Worker payload',async()=>{
  vi.mocked(selectProjectGwsConnection).mockResolvedValue({id:'gws-work',displayName:'Work',isProjectDefault:true});
  vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({value:'encoded-bundle',credentialId:'gws-work'});
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'gws auth status'}});
  expect(result.request.env).toMatchObject({TOWER_REMOTE_GWS_CONFIG_B64:'encoded-bundle'});
  expect(result.request.env).not.toHaveProperty('SSL_CERT_FILE');
  expect(result.selectedBundles).toEqual([{credentialId:'gws-work',provider:'google'}]);
 });
 it.each([['member',7],['operator',8],['admin',9]])('keeps %s requester identity audit-only in GWS envelopes',async (_role,userId)=>{
  vi.mocked(selectProjectGwsConnection).mockResolvedValue({id:'gws-work',displayName:'Work',isProjectDefault:true});
  vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({value:'encoded-bundle',credentialId:'gws-work'});
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:Number(userId),request:{command:'gws auth status',env:{TOWER_REMOTE_GWS_USER_ID:'777',TOWER_REMOTE_GWS_CONFIG_B64:'caller-bundle'}}});
  expect(result.request.env).toEqual({TOWER_REMOTE_GWS_CONFIG_B64:'encoded-bundle'});
  expect(selectProjectGwsConnection).toHaveBeenCalledWith({projectId:'p',requestedCredentialId:null});
  expect(resolveProjectCredentialSecretValue).toHaveBeenCalledWith(expect.objectContaining({projectId:'p',userId,credentialId:'gws-work'}));
 });
 it('preserves an explicit CA path instead of replacing it with a controller path',async()=>{
  vi.mocked(selectProjectGwsConnection).mockResolvedValue({id:'gws-work',displayName:'Work',isProjectDefault:true});
  vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({value:'encoded-bundle',credentialId:'gws-work'});
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'gws auth status',env:{SSL_CERT_FILE:'/custom-ca/bundle.crt'}}});
  expect(result.request.env!.SSL_CERT_FILE).toBe('/custom-ca/bundle.crt');
 });
 it('ignores unrelated file Credentials and envelopes an explicitly requested file for Worker-local materialization',async()=>{
  vi.mocked(resolveRuntimeBoxCredentialFileMaterialization).mockImplementation(async({requestedEnvNames}:any)=>({materialize:requestedEnvNames.has('CONFIG_PATH')?[{credentialId:'c',envName:'CONFIG_PATH',fileName:'config.json',mode:'0600',credentialType:'json',value:'hidden'}]:[],skipped:[]} as any));
  const unrelated=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'typst --version'}});
  expect(unrelated.request.env).toEqual({});
  const requested=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'python work/use_config.py --config $CONFIG_PATH'}});
  expect(requested.environmentKeys).toEqual(['TOWER_REMOTE_FILE_CREDENTIAL_0']);
  const payload=JSON.parse(Buffer.from(requested.request.env!.TOWER_REMOTE_FILE_CREDENTIAL_0,'base64').toString('utf8'));
  expect(payload).toEqual({envName:'CONFIG_PATH',fileName:'config.json',mode:'0600',credentialType:'json',value:'hidden'});
 });
 it('requests an SSH file Credential by its stored private-key env while exposing only the path env',async()=>{
  vi.mocked(resolveRuntimeBoxCredentialFileMaterialization).mockImplementation(async({requestedEnvNames}:any)=>({materialize:requestedEnvNames.has('MOAT_LLM_ROUTER_SSH_PRIVATE_KEY')?[{credentialId:'moat-llm-router-ssh-private-key',envName:'MOAT_LLM_ROUTER_SSH_KEY_FILE',fileName:'id_ssh',mode:'0600',credentialType:'ssh_private_key',value:'hidden'}]:[],skipped:[]} as any));
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'# tower-credentials: MOAT_LLM_ROUTER_SSH_PRIVATE_KEY\nssh -i "$MOAT_LLM_ROUTER_SSH_KEY_FILE" router.example.test true'}});
  expect(result.request.env).not.toHaveProperty('MOAT_LLM_ROUTER_SSH_PRIVATE_KEY');
  expect(result.environmentKeys).toEqual(['TOWER_REMOTE_FILE_CREDENTIAL_0']);
  const payload=JSON.parse(Buffer.from(result.request.env!.TOWER_REMOTE_FILE_CREDENTIAL_0,'base64').toString('utf8'));
  expect(payload).toMatchObject({envName:'MOAT_LLM_ROUTER_SSH_KEY_FILE',mode:'0600',credentialType:'ssh_private_key'});
 });
});

it('returns metadata-only reasons for unresolved explicit requirements', async () => {
  vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({env:{},injected:[],skipped:[]});
  const result = await resolveRemoteWorkbenchCredentialEnv({projectId:'agent-a',userId:7,request:{command:'make verify',credentialRequirements:['SUPABASE_ACCESS_TOKEN']}});
  expect(result.unsatisfiedRequirements).toEqual(['SUPABASE_ACCESS_TOKEN']);
  expect(result.unresolvedReasons).toEqual([{envName:'SUPABASE_ACCESS_TOKEN',reason:'NoAccessibleMatchingCredential'}]);
});
