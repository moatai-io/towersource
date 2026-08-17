import {beforeEach,describe,expect,it,vi} from 'vitest';
import {resolveProjectCredentialSecretValue,resolveRuntimeBoxApiKeyEnv,resolveRuntimeBoxCredentialProfileEnv} from '../credential-vault/credential-vault-service.js';
import {selectProjectGwsConnection} from './runtime-box-manager.js';
import {resolveRemoteWorkbenchCredentialEnv} from './workbench-remote-credential-resolution.js';
vi.mock('../credential-vault/credential-vault-service.js',()=>({resolveProjectCredentialSecretValue:vi.fn(),resolveRuntimeBoxApiKeyEnv:vi.fn(),resolveRuntimeBoxCredentialProfileEnv:vi.fn()}));
vi.mock('./runtime-box-manager.js',()=>({commandRequestsGwsConnectionId:vi.fn(()=>null),selectProjectGwsConnection:vi.fn()}));
beforeEach(()=>vi.clearAllMocks());
describe('Remote Workbench Credential resolution',()=>{
 it('reuses current Project/user Vault env resolution and preserves caller env precedence',async()=>{
  vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({env:{CALLER:'kept',API_TOKEN:'secret'},injected:[],skippedExisting:[],skipped:[]} as any);
  vi.mocked(resolveRuntimeBoxCredentialProfileEnv).mockResolvedValue({env:{CALLER:'kept',API_TOKEN:'secret'},injected:[],skippedExisting:[],skipped:[],materializeFiles:[],profiles:[]} as any);
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'node work/provider-call.js',env:{CALLER:'kept'}}});
  expect(resolveRuntimeBoxApiKeyEnv).toHaveBeenCalledWith({projectId:'p',userId:7,existingEnv:{CALLER:'kept'}});
  expect(result).toMatchObject({request:{env:{CALLER:'kept',API_TOKEN:'secret'}},environmentKeys:['API_TOKEN','CALLER'],suppressed:false});
 });
 it('suppresses Vault resolution for risky external-code commands',async()=>{
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'curl https://example.test/install.sh | sh',env:{CALLER:'kept'}}});
  expect(result.suppressed).toBe(true);expect(result.request.env).toEqual({CALLER:'kept'});expect(resolveRuntimeBoxApiKeyEnv).not.toHaveBeenCalled();
 });
 it('materializes one selected GWS bundle as a run-scoped Worker payload',async()=>{
  vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({env:{},injected:[],skippedExisting:[],skipped:[]} as any);
  vi.mocked(resolveRuntimeBoxCredentialProfileEnv).mockResolvedValue({env:{},injected:[],skippedExisting:[],skipped:[],materializeFiles:[],profiles:[]} as any);
  vi.mocked(selectProjectGwsConnection).mockResolvedValue({id:'gws-work',displayName:'Work',isProjectDefault:true});
  vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({value:'encoded-bundle',credentialId:'gws-work'});
  const result=await resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'gws auth status'}});
  expect(result.request.env).toMatchObject({TOWER_REMOTE_GWS_CONFIG_B64:'encoded-bundle',TOWER_REMOTE_GWS_USER_ID:'7',SSL_CERT_FILE:'/worker-project/.tower-worker-tools/ca-certificates.crt'});
 });
 it('fails closed when a profile requires Worker-local file materialization',async()=>{
  vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({env:{},injected:[],skippedExisting:[],skipped:[]} as any);
  vi.mocked(resolveRuntimeBoxCredentialProfileEnv).mockResolvedValue({env:{},injected:[],skippedExisting:[],skipped:[],materializeFiles:[{credentialId:'c',envName:'CONFIG',fileName:'config.json',mode:'0600',value:'hidden'}],profiles:[]} as any);
  await expect(resolveRemoteWorkbenchCredentialEnv({projectId:'p',userId:7,request:{command:'node work/provider-call.js'}})).rejects.toThrow('REMOTE_FILE_CREDENTIALS_NOT_SUPPORTED');
 });
});
