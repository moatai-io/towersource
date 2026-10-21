import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), secret: vi.fn(), getSecret: vi.fn(),reload:vi.fn(),engine:vi.fn(),registryReload:vi.fn() }));
vi.mock('../../config.js', () => ({loadModelsFile:m.load,saveModelsFile:m.save,reloadModels:m.reload}));
vi.mock('../../engines/index.js',()=>({getEngine:m.engine}));
vi.mock('../secret/secret-store.js', () => ({setSecret:m.secret,getSecret:m.getSecret}));
import { activateCustomerLiteLLMRuntime, assertCustomerLiteLLMBinding, configureCustomerLiteLLMFromVault, configureLiteLLMVm } from './litellm-setup.js';
const input = {baseUrl:'https://router.example.com/v1',apiKey:'synthetic-test',actorUserId:7};
const catalog = () => ({data:[{id:'gpt-6.1-sol'},{id:'~deepseek/deepseek-pro-latest'},{id:'z-ai/glm-5.3'}]});
const response = (value: unknown = catalog()) => Response.json(value);
const vaultInput = {baseUrl:input.baseUrl,actorUserId:7,secretName:'VAULT_'+'A'.repeat(56)};
beforeEach(() => {vi.resetAllMocks();m.load.mockReturnValue({claude:[],defaults:{session:'unchanged'},pi:[]});m.getSecret.mockResolvedValue(input.apiKey);m.engine.mockResolvedValue({reloadModelRegistry:m.registryReload});vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>response()));});
afterEach(() => vi.unstubAllGlobals());
describe('LiteLLM VM configuration', () => {
 it('preserves models/defaults and stores only a reference in config',async()=>{
  expect(await configureLiteLLMVm(input)).toEqual({restartRequired:true});
  expect(m.secret).toHaveBeenCalledWith(expect.objectContaining({scope:'global',createdBy:7,value:input.apiKey}));
  expect(m.save.mock.calls[0][0].defaults).toEqual({session:'unchanged'});
  expect(JSON.stringify(m.save.mock.calls)).not.toContain(input.apiKey);
 });
 it('does not persist rejected credentials or provider error text',async()=>{
  vi.mocked(fetch).mockResolvedValue(new Response('private provider error', {status:401}));
  await expect(configureLiteLLMVm(input)).rejects.toThrow('HTTP 401');expect(m.secret).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();
 });
 it('rejects missing actor before network access',async()=>{
  await expect(configureLiteLLMVm({...input,actorUserId:0})).rejects.toThrow('operator');expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects embedded credentials',async()=>{
  await expect(configureLiteLLMVm({...input,baseUrl:'https://a:b@example.com'})).rejects.toThrow('Invalid');expect(fetch).not.toHaveBeenCalled();
 });
 it('does not publish a binding when secret persistence fails',async()=>{
  m.secret.mockRejectedValue(new Error('storage unavailable'));
  await expect(configureLiteLLMVm(input)).rejects.toThrow();expect(m.save).not.toHaveBeenCalled();
 });
});

it('uses distinct secret generations across retries', async () => {
 await configureLiteLLMVm(input); await configureLiteLLMVm(input);
 expect(m.secret.mock.calls[0][0].name).not.toBe(m.secret.mock.calls[1][0].name);
});
it('applies explicit onboarding defaults before binding while saving only a Vault reference', async () => {
 m.load.mockReturnValue({claude:[],pi:[],defaults:{session:'old'}});
 vi.mocked(fetch).mockResolvedValue(response());
 await configureLiteLLMVm({...input,bootstrapDefaults:true});
 expect(m.save.mock.calls[0][0].defaults).toMatchObject({session:'litellm-responses/~deepseek/deepseek-pro-latest',ai_task:'litellm-responses/~deepseek/deepseek-pro-latest'});
 expect(m.save.mock.calls[0][0].customerAiBootstrap.version).toBe(1);
 expect(JSON.stringify(m.save.mock.calls)).not.toContain(input.apiKey);
});
it('rejects an incomplete onboarding catalog before writing any secret', async () => {
 m.load.mockReturnValue({claude:[],pi:[],defaults:{session:'old'}});
 vi.mocked(fetch).mockResolvedValue(response({data:[{id:'gpt-6.1-sol'}]}));
 await expect(configureLiteLLMVm({...input,bootstrapDefaults:true})).rejects.toThrow('missing required');
 expect(m.secret).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();
});
it('does not reset administrator model choices on setup re-entry', async () => {
 const file={claude:[],pi:[],defaults:{session:'operator-model'},inferenceProviders:{'litellm-responses':{baseUrl:input.baseUrl,secretName:'OLD',configuredAt:'2026-01-01'}}};
 m.load.mockReturnValue(file);vi.mocked(fetch).mockResolvedValue(response({data:[]}));
 await configureLiteLLMVm({...input,bootstrapDefaults:true});
 expect(m.save.mock.calls[0][0].defaults.session).toBe('operator-model');expect(file.inferenceProviders['litellm-responses'].secretName).toBe('OLD');
});
it('preserves old binding when config write fails', async () => {
 const file={pi:[],inferenceProviders:{'litellm-responses':{baseUrl:input.baseUrl,secretName:'OLD'}}};
 m.load.mockReturnValue(file);m.save.mockImplementation(()=>{throw new Error('disk full');});
 await expect(configureLiteLLMVm(input)).rejects.toThrow('disk full');
 expect(file.inferenceProviders['litellm-responses'].secretName).toBe('OLD');
 expect(m.secret.mock.calls[0][0].name).not.toBe('OLD');
});

describe('bounded Team catalog', () => {
 it('rejects invalid JSON without echoing its body or writing a key', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('private-not-json'));
  await expect(configureLiteLLMVm({...input,bootstrapDefaults:true})).rejects.toThrow('invalid JSON');
  expect(m.secret).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();
 });
 it.each(['1048577','invalid'])('rejects unsafe content length %s', async length => {
  vi.mocked(fetch).mockResolvedValue(new Response('{}',{headers:{'content-length':length}}));
  await expect(configureLiteLLMVm({...input,bootstrapDefaults:true})).rejects.toThrow('size limit');
  expect(m.secret).not.toHaveBeenCalled();
 });
 it('bounds a chunked body without trusting declared size', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(' '.repeat(1_048_577)));
  await expect(configureLiteLLMVm({...input,bootstrapDefaults:true})).rejects.toThrow('size limit');
  expect(m.save).not.toHaveBeenCalled();
 });
 it('redacts a failed response stream', async () => {
  const body=new ReadableStream({start(c){c.error(new Error('private-stream-details'));}});
  vi.mocked(fetch).mockResolvedValue(new Response(body));
  await expect(configureLiteLLMVm({...input,bootstrapDefaults:true})).rejects.toThrow('catalog read failed');
  expect(m.secret).not.toHaveBeenCalled();
 });
 it('does not follow a redirect with a customer credential', async () => {
  await configureLiteLLMVm(input);
  expect(fetch).toHaveBeenCalledWith(input.baseUrl+'/models',expect.objectContaining({redirect:'error'}));
 });
});

describe('customer Vault inference binding', () => {
 it('uses the existing Vault reference and sets first defaults without another secret row', async () => {
  await expect(configureCustomerLiteLLMFromVault(vaultInput)).resolves.toEqual({restartRequired:true});
  expect(m.getSecret).toHaveBeenCalledWith(vaultInput.secretName,0);
  expect(m.secret).not.toHaveBeenCalled();
  const saved=m.save.mock.calls[0][0];
  expect(saved.inferenceProviders['litellm-responses']).toMatchObject({baseUrl:input.baseUrl,secretName:vaultInput.secretName});
  expect(saved.customerAiBootstrap.coreModel).toBe('litellm-responses/~deepseek/deepseek-pro-latest');
  expect(JSON.stringify(saved)).not.toContain(input.apiKey);
 });
 it('preserves administrator defaults and initialization timestamp on the same reference', async () => {
  const file={claude:[],pi:[],defaults:{session:'operator-choice'},inferenceProviders:{'litellm-responses':{baseUrl:input.baseUrl,secretName:vaultInput.secretName,configuredAt:'2026-01-01'}}};
  m.load.mockReturnValue(file);
  await configureCustomerLiteLLMFromVault(vaultInput);
  expect(m.save.mock.calls[0][0].defaults).toEqual(file.defaults);
  expect(m.save.mock.calls[0][0].inferenceProviders['litellm-responses'].configuredAt).toBe('2026-01-01');
  expect(m.save.mock.calls[0][0].customerAiBootstrap).toBeUndefined();
 });
 it('refuses an existing different reference before materializing the key', async () => {
  m.load.mockReturnValue({pi:[],inferenceProviders:{'litellm-responses':{baseUrl:input.baseUrl,secretName:'OLD'}}});
  await expect(configureCustomerLiteLLMFromVault(vaultInput)).rejects.toThrow('already configured');
  expect(m.getSecret).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 });
 it('refuses a concurrent administrator binding after the probe', async () => {
  m.load.mockReturnValueOnce({pi:[]}).mockReturnValue({pi:[],inferenceProviders:{'litellm-responses':{baseUrl:input.baseUrl,secretName:'OTHER'}}});
  await expect(configureCustomerLiteLLMFromVault(vaultInput)).rejects.toThrow('already configured');
  expect(m.save).not.toHaveBeenCalled();
 });
 it('preserves administrator settings saved while the network request was pending', async () => {
  const changed={pi:[],defaults:{session:'new-operator-choice'},inferenceProviders:{'litellm-responses':{baseUrl:input.baseUrl,secretName:vaultInput.secretName,configuredAt:'original'}}};
  m.load.mockReturnValueOnce({pi:[]}).mockReturnValue(changed);
  await configureCustomerLiteLLMFromVault(vaultInput);
  expect(m.save.mock.calls[0][0].defaults).toEqual(changed.defaults);
 });
 it('redacts Vault errors without a config write', async () => {
  m.getSecret.mockRejectedValue(new Error('private-vault-details'));
  await expect(configureCustomerLiteLLMFromVault(vaultInput)).rejects.toThrow('Vault material unavailable');
  expect(m.save).not.toHaveBeenCalled();
 });
 it('requires a local actor and exact customer secret name', async () => {
  await expect(configureCustomerLiteLLMFromVault({...vaultInput,actorUserId:0})).rejects.toThrow('operator required');
  await expect(configureCustomerLiteLLMFromVault({...vaultInput,secretName:'MASTER'})).rejects.toThrow('reference invalid');
  expect(m.getSecret).not.toHaveBeenCalled();
 });
 it('does not claim readback until the exact binding was persisted', () => {
  expect(()=>assertCustomerLiteLLMBinding(vaultInput)).toThrow('readback mismatch');
  m.load.mockReturnValue({pi:[],inferenceProviders:{'litellm-responses':{baseUrl:input.baseUrl,secretName:vaultInput.secretName,configuredAt:'original'}}});
  expect(()=>assertCustomerLiteLLMBinding(vaultInput)).not.toThrow();
  expect(()=>assertCustomerLiteLLMBinding({...vaultInput,baseUrl:'https://other.example/v1'})).toThrow('readback mismatch');
 });
});

it('activates only through the existing model reload path, without a host restart',async()=>{
 await activateCustomerLiteLLMRuntime();expect(m.reload).toHaveBeenCalledOnce();expect(m.engine).toHaveBeenCalledWith('pi');expect(m.registryReload).toHaveBeenCalledOnce();
 m.engine.mockResolvedValue({});await expect(activateCustomerLiteLLMRuntime()).rejects.toThrow('activation unavailable');
});
