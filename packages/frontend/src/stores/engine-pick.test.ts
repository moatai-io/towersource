import { describe, it, expect, vi, afterEach } from 'vitest';
import { decideEnginePick, patchSessionModel } from './engine-pick';

afterEach(() => vi.unstubAllGlobals());

describe('patchSessionModel', () => {
  it('reports rejected model persistence instead of silently accepting a failed PATCH', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await expect(patchSessionModel('session-1', { modelUsed: 'litellm-responses/gpt-5.6-sol' }))
      .rejects.toThrow('Session model update failed (400)');
  });
});

describe('decideEnginePick', () => {
  it('same engine → model_only (cheap PATCH, no swap)', () => {
    expect(decideEnginePick({
      sessionEngine: 'pi',
      pickedEngine: 'pi',
      backendModel: 'openrouter/kimi-k2',
      hasHistory: true,
    })).toEqual({ kind: 'model_only', backendModel: 'openrouter/kimi-k2' });
  });

  it('no session engine yet → model_only (new session default, never a switch)', () => {
    expect(decideEnginePick({
      sessionEngine: undefined,
      pickedEngine: 'claude',
      backendModel: 'claude-opus-4-8',
      hasHistory: false,
    })).toEqual({ kind: 'model_only', backendModel: 'claude-opus-4-8' });
  });

  it('different engine + empty session → safe_swap (lossless, raw PATCH ok)', () => {
    expect(decideEnginePick({
      sessionEngine: 'claude',
      pickedEngine: 'pi',
      backendModel: 'openrouter/kimi-k2',
      hasHistory: false,
    })).toEqual({ kind: 'safe_swap', toEngine: 'pi', backendModel: 'openrouter/kimi-k2' });
  });

  it('different engine + real history → needs_confirm (must rehydrate)', () => {
    expect(decideEnginePick({
      sessionEngine: 'claude',
      pickedEngine: 'pi',
      backendModel: 'openrouter/kimi-k2',
      hasHistory: true,
    })).toEqual({
      kind: 'needs_confirm',
      fromEngine: 'claude',
      toEngine: 'pi',
      backendModel: 'openrouter/kimi-k2',
    });
  });

  it('pi → claude with history also needs confirm (symmetric — direction is not special-cased here)', () => {
    expect(decideEnginePick({
      sessionEngine: 'pi',
      pickedEngine: 'claude',
      backendModel: 'claude-opus-4-8',
      hasHistory: true,
    })).toMatchObject({ kind: 'needs_confirm', fromEngine: 'pi', toEngine: 'claude' });
  });

  it('local → pi empty session → safe_swap', () => {
    expect(decideEnginePick({
      sessionEngine: 'local',
      pickedEngine: 'pi',
      backendModel: 'openrouter/x',
      hasHistory: false,
    })).toMatchObject({ kind: 'safe_swap', toEngine: 'pi' });
  });
});
