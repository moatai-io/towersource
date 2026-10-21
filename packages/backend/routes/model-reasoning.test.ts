import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const block = source.slice(source.indexOf("router.patch('/admin/models/reasoning'"), source.indexOf("router.put('/admin/models'"));
function harness() {
  let handler: any;
  const middleware = vi.fn();
  const file = { pi: [{ provider: 'litellm-responses', modelId: 'gpt-6-sol', reasoning: true, defaultReasoning: 'high' }], defaults: { session: 'preset/core' }, modelPolicies: { revision: 9 }, inferenceProviders: { synthetic: {} } };
  const save = vi.fn();
  const router = { patch: vi.fn((_path, guard, fn) => { expect(guard).toBe(middleware); handler = fn; }) };
  // Execute the actual bounded route body, isolated from shared database and server startup.
  new Function('router', 'operatorOrAboveMiddleware', 'loadModelsFile', 'saveModelsFile', 'isReasoningEffort', 'reasoningEffortsForModel', ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(router, middleware, () => file, save, (value: unknown) => typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value), (provider: string, modelId: string) => provider === 'litellm-responses' ? ['low', 'medium', 'high', 'xhigh'] : []);
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return { handler, file, save, res };
}
describe('admin reasoning PATCH route', () => {
  it('updates just one field while preserving policies, defaults and bindings', () => {
    const h = harness();
    h.handler({ body: { provider: 'litellm-responses', modelId: 'gpt-6-sol', defaultReasoning: 'xhigh' } }, h.res);
    expect(h.save).toHaveBeenCalledWith(h.file);
    expect(h.file.pi[0].defaultReasoning).toBe('xhigh');
    expect(h.file.modelPolicies.revision).toBe(9);
    expect(h.file.defaults.session).toBe('preset/core');
    expect(h.file.inferenceProviders).toEqual({ synthetic: {} });
    expect(h.res.status).not.toHaveBeenCalled();
  });
  it.each([{}, { provider: 'wrong', modelId: 'gpt-6-sol', defaultReasoning: 'high' }, { provider: 'litellm-responses', modelId: 'gpt-6-sol', defaultReasoning: 'max' }])('rejects invalid input without saving: %j', body => {
    const h = harness(); h.handler({ body }, h.res);
    expect(h.res.status).toHaveBeenCalledWith(400); expect(h.save).not.toHaveBeenCalled();
  });
  it('rejects missing or non-reasoning models', () => {
    const h = harness(); h.handler({ body: { provider: 'litellm-responses', modelId: 'unknown', defaultReasoning: 'low' } }, h.res);
    expect(h.res.status).toHaveBeenCalledWith(404); expect(h.save).not.toHaveBeenCalled();
  });
  it('reports disk errors rather than a successful save', () => {
    const h = harness(); h.save.mockImplementation(() => { throw new Error('write failed'); });
    h.handler({ body: { provider: 'litellm-responses', modelId: 'gpt-6-sol', defaultReasoning: 'low' } }, h.res);
    expect(h.res.status).toHaveBeenCalledWith(500);
  });
});
