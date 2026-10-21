import { afterEach, describe, expect, it } from 'vitest';
import { getModelDefaults } from '../../config.js';
import { getInferenceProviderReadiness } from './inference-provider-readiness.js';

const originalOpenRouter = process.env.OPENROUTER_API_KEY;
const originalResponses = process.env.OPENAI_RESPONSES_API_KEY;
const originalLiteBase = process.env.LITELLM_BASE_URL;
const originalLiteKey = process.env.LITELLM_API_KEY;
const originalAzure = process.env.AZURE_OPENAI_API_KEY;
const originalAnthropic = process.env.ANTHROPIC_API_KEY;
const originalCodexBase = process.env.CODEX_LB_BASE_URL;
const originalCodexKey = process.env.CODEX_LB_API_KEY;

afterEach(() => {
  if (originalOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalOpenRouter;
  if (originalResponses === undefined) delete process.env.OPENAI_RESPONSES_API_KEY; else process.env.OPENAI_RESPONSES_API_KEY = originalResponses;
  if (originalLiteBase === undefined) delete process.env.LITELLM_BASE_URL; else process.env.LITELLM_BASE_URL = originalLiteBase;
  if (originalLiteKey === undefined) delete process.env.LITELLM_API_KEY; else process.env.LITELLM_API_KEY = originalLiteKey;
  if (originalAzure === undefined) delete process.env.AZURE_OPENAI_API_KEY; else process.env.AZURE_OPENAI_API_KEY = originalAzure;
  if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalAnthropic;
  if (originalCodexBase === undefined) delete process.env.CODEX_LB_BASE_URL; else process.env.CODEX_LB_BASE_URL = originalCodexBase;
  if (originalCodexKey === undefined) delete process.env.CODEX_LB_API_KEY; else process.env.CODEX_LB_API_KEY = originalCodexKey;
});

describe('inference provider readiness', () => {
  it('requires setup when no supported provider key is configured', () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_RESPONSES_API_KEY;
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CODEX_LB_BASE_URL;
    delete process.env.CODEX_LB_API_KEY;
    expect(getInferenceProviderReadiness()).toMatchObject({ status: 'setup_required', reason: 'no_provider' });
  });

  it('does not count direct provider keys as supported readiness', () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_API_KEY;
    process.env.OPENAI_RESPONSES_API_KEY = 'test-redacted';
    process.env.AZURE_OPENAI_API_KEY = 'test-redacted';
    expect(getInferenceProviderReadiness()).toMatchObject({ status: 'setup_required', reason: 'no_provider' });
  });

  it('accepts the active VM provider when its credentials are configured', () => {
    process.env.LITELLM_BASE_URL = 'https://router.example.com/v1';
    process.env.LITELLM_API_KEY = 'test-redacted';
    expect(getInferenceProviderReadiness()).toMatchObject({ status: 'ready', defaultModel: getModelDefaults().session });
  });
});
