import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('./model-management/ModelManagement.tsx', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../../locales/en/admin.json', import.meta.url), 'utf8'));
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/admin.json', import.meta.url), 'utf8'));
describe('Inference setup wizard', () => {
  it('removes direct provider setup from the simplified router settings', () => {
    expect(source).not.toContain('/admin/inference-setup/${action}');
    expect(source).toContain('/admin/ai-models/router-connection');
    expect(source).not.toContain('The key is encrypted in Tower Credential Vault');
  });
  it('ships English source and Korean translation keys', () => {
    expect(en.inferenceWizard.title).toBe('Connect an AI provider');
    expect(ko.inferenceWizard.title).toBe('AI 서비스 제공자 연결');
    expect(Object.keys(ko.inferenceWizard)).toEqual(Object.keys(en.inferenceWizard));
  });
});
