import fs from 'node:fs';
import { describe,it,expect } from 'vitest';
describe('LiteLLM consumer wiring',()=>{
 it('routes Router Responses through the shared resolver and keeps OpenRouter separate',()=>{
  const s=fs.readFileSync(new URL('../../engines/pi/quick-reply.ts',import.meta.url),'utf8');
  expect(s.match(/await resolveLiteLLMCredentials\(\)/g)).toHaveLength(1);
  expect(s).toContain('`${baseUrl}/responses`');
  expect(s).toContain("resolveConfiguredInferenceProviderSecret('openrouter', 0)");
  expect(s).toContain('https://openrouter.ai/api/v1/chat/completions');
  expect(s).not.toContain('`${baseUrl}/chat/completions`');
  expect(s).not.toContain('process.env.LITELLM_API_KEY');
 });
 it('loads VM credentials before registering session models',()=>{
  const s=fs.readFileSync(new URL('../../engines/pi/model-registry.ts',import.meta.url),'utf8');
  expect(s.indexOf("await resolveLiteLLMCredentials()")).toBeLessThan(s.indexOf('this.registerCustomModels(registry)'));
  expect(s).toContain("providerOpts.apiKey = this.vmProviderCredentials.get('litellm-responses')?.apiKey");
 });
 it('uses VM credentials for budget snapshot without replacing the admin key',()=>{
  const s=fs.readFileSync(new URL('./ai-token-budget.ts',import.meta.url),'utf8');
  expect(s).toContain('connection = await resolveLiteLLMCredentials()');
  expect(s).toContain('process.env.LITELLM_ADMIN_API_KEY');
 });
});
