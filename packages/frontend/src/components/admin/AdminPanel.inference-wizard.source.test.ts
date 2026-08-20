import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../../locales/en/admin.json', import.meta.url), 'utf8'));
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/admin.json', import.meta.url), 'utf8'));
describe('Inference setup wizard', () => {
  it('uses password input and admin setup endpoints', () => {
    expect(source).toContain('type="password"');
    expect(source).toContain('/admin/inference-setup/${action}');
    expect(source).not.toContain('The key is encrypted in Tower Credential Vault');
  });
  it('ships English source and Korean translation keys', () => {
    expect(en.inferenceWizard.title).toBe('Connect an AI provider');
    expect(ko.inferenceWizard.title).toBe('AI Provider 연결');
    expect(Object.keys(ko.inferenceWizard)).toEqual(Object.keys(en.inferenceWizard));
  });
});
