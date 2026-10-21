import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'inference-provider-setup.ts'), 'utf8');

describe('public inference provider boundary', () => {
  it('does not offer direct OpenAI-compatible Responses onboarding', () => {
    expect(source).toContain("export type PublicInferenceProvider = 'openrouter'");
    expect(source).not.toContain("'openai-responses-compatible': {");
    expect(source).toContain("url !== 'https://openrouter.ai/api/v1'");
  });
});
