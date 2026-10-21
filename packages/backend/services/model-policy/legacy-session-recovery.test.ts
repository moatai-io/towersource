import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ selectable: new Set(['litellm-responses/gpt-6-sol', 'litellm-responses/mini']) }));
vi.mock('../../config.js', () => ({
  isSelectablePiModelId: (model: string) => state.selectable.has(model.replace(/^pi:/, '')),
}));
import { recoverLegacySessionChoice } from './legacy-session-recovery.js';

const legacy = 'litellm-responses/smart';
describe('retired persisted Pi model continuation', () => {
  beforeEach(() => { state.selectable = new Set(['litellm-responses/gpt-6-sol', 'litellm-responses/mini']); });

  it.each([legacy, `pi:${legacy}`, undefined])('recovers a previously saved, no longer selectable model (request %s)', requested => {
    expect(recoverLegacySessionChoice(requested, legacy)).toBe('preset/core');
  });
  it('also recovers a removed direct entry, including legacy Smartest', () => {
    expect(recoverLegacySessionChoice('litellm-responses/smartest', 'litellm-responses/smartest')).toBe('preset/core');
    expect(recoverLegacySessionChoice('litellm-responses/gpt55', 'litellm-responses/gpt55')).toBe('preset/core');
  });
  it('preserves a currently selectable direct model regardless of the admin Core mapping', () => {
    expect(recoverLegacySessionChoice('litellm-responses/gpt-6-sol', 'litellm-responses/gpt-6-sol')).toBeUndefined();
    state.selectable.add(legacy);
    expect(recoverLegacySessionChoice(legacy, legacy)).toBeUndefined();
  });
  it.each(['litellm-responses/forbidden', 'preset/lite', 'litellm-responses/gpt-6-sol', ''])('never overrides a different explicit choice %s', requested => {
    expect(recoverLegacySessionChoice(requested, legacy)).toBeUndefined();
  });
  it.each([undefined, null, '', 'preset/core', 'policy/lite'])('does not migrate missing or managed preset choice %s', stored => {
    expect(recoverLegacySessionChoice(undefined, stored)).toBeUndefined();
  });
  it('does not auto-recover an unknown model sent to a session without that stored choice', () => {
    expect(recoverLegacySessionChoice('litellm-responses/forbidden', undefined)).toBeUndefined();
  });
});
