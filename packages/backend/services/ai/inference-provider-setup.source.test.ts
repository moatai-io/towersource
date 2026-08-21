import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'inference-provider-setup.ts'), 'utf8');

describe('public inference provider defaults', () => {
  it('uses GPT-5.6 Terra for direct OpenAI Responses onboarding', () => {
    const openaiBlock = source.slice(
      source.indexOf("'openai-responses-compatible':"),
      source.indexOf('\n  },', source.indexOf("'openai-responses-compatible':")) + 5,
    );
    expect(openaiBlock).toContain("defaultBaseUrl: 'https://api.openai.com/v1'");
    expect(openaiBlock).toContain("defaultModel: 'gpt-5.6-terra'");
    expect(openaiBlock).toContain("api: 'openai-responses'");
  });
});
