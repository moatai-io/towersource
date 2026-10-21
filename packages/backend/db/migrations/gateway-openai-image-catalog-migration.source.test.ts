import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/216_gateway_openai_image_catalog.sql'), 'utf8');

describe('OpenAI Image Gateway catalog migration', () => {
  it('registers image generation separately without storing credentials', () => {
    expect(sql).toContain("'openai-image'");
    expect(sql).toContain("'/openai'");
    expect(sql).toContain("'image_generation'");
    expect(sql).toContain("'OPENAI_IMAGE_BASE_URL'");
    expect(sql).toContain("'images'");
    expect(sql).toContain('/images/generations');
    expect(sql).toContain('/images/edits');
    expect(sql).toContain('"defaultModel":"gpt-image-2.5-sunburst"');
    expect(sql).not.toMatch(/secret_value|credential_id/i);
  });
});
