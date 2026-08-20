import {beforeEach,describe,expect,it,vi} from 'vitest';
import {resolveProjectCredentialSecretValue,resolveRuntimeBoxApiKeyEnv,resolveRuntimeBoxCredentialProfileEnv} from '../credential-vault/credential-vault-service.js';
import {selectProjectGwsConnection} from './runtime-box-manager.js';
import {requestedCredentialEnvNames,resolveRemoteWorkbenchCredentialEnv} from './workbench-remote-credential-resolution.js';
vi.mock('../credential-vault/credential-vault-service.js',()=>({resolveProjectCredentialSecretValue:vi.fn(),resolveRuntimeBoxApiKeyEnv:vi.fn(),resolveRuntimeBoxCredentialProfileEnv:vi.fn()}));
vi.mock('./runtime-box-manager.js',()=>({commandRequestsGwsConnectionId:vi.fn(()=>null),selectProjectGwsConnection:vi.fn()}));
beforeEach(()=>{
 vi.clearAllMocks();
 vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({env:{OPENAI_API_KEY:'openai',NAVER_CLIENT_ID:'naver'},injected:[],skippedExisting:[],skipped:[]} as any);
 vi.mocked(resolveRuntimeBoxCredentialProfileEnv).mockImplementation(async({existingEnv}:any)=>({env:{...existingEnv,FRAPPE_CONNECTION_JSON:'frappe'},injected:[],skippedExisting:[],skipped:[],materializeFiles:[],profiles:[]} as any));
});
describe('Remote Workbench Credential resolution',()=>{
 it('injects no unrelated Vault Credentials for an ordinary toolchain command',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'typst --version; pandoc --version',env:{CALLER:'kept'}}});
  expect(result).toMatchObject({request:{env:{CALLER:'kept'}},environmentKeys:['CALLER'],suppressed:false});
 });
 it('selects only the provider scope explicitly named by the command',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'python work/openai_image.py'}});
  expect(result.request.env).toEqual({OPENAI_API_KEY:'openai'});
  expect(result.environmentKeys).toEqual(['OPENAI_API_KEY']);
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
 it('materializes one selected GWS bundle as a run-scoped Worker payload',async()=>{
  vi.mocked(selectProjectGwsConnection).mockResolvedValue({id:'gws-work',displayName:'Work',isProjectDefault:true});
  vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({value:'encoded-bundle',credentialId:'gws-work'});
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'gws auth status'}});
  expect(result.request.env).toMatchObject({TOWER_REMOTE_GWS_CONFIG_B64:'encoded-bundle',TOWER_REMOTE_GWS_USER_ID:'7',SSL_CERT_FILE:'/worker-project/.tower-worker-tools/ca-certificates.crt'});
 });
 it('ignores unrelated file profiles but fails closed when that env is explicitly requested',async()=>{
  vi.mocked(resolveRuntimeBoxCredentialProfileEnv).mockResolvedValue({env:{},injected:[],skippedExisting:[],skipped:[],materializeFiles:[{credentialId:'c',envName:'CONFIG_PATH',fileName:'config.json',mode:'0600',value:'hidden'}],profiles:[]} as any);
  const unrelated=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'typst --version'}});
  expect(unrelated.request.env).toEqual({});
  await expect(resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'python work/use_config.py --config $CONFIG_PATH'}})).rejects.toThrow('REMOTE_FILE_CREDENTIALS_NOT_SUPPORTED');
 });
});
