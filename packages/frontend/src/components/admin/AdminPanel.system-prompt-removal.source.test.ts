import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

describe('Admin system prompt removal', () => {
  it('does not expose the retired system prompt tab or editor', () => {
    expect(source).not.toContain("'prompts'");
    expect(source).not.toContain("renderTab('prompts'");
    expect(source).not.toContain('SystemPromptEditor');
    expect(source).not.toContain('/admin/system-prompts');
    expect(source).not.toContain('/admin/prompt-inspector');
  });
});
