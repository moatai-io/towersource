import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './useChatRuntime.ts'), 'utf8');

describe('agent draft patch transcript handling', () => {
  it('hides completed and still-streaming patch blocks', () => {
    expect(source).toContain("text.replace(/```tower-agent-draft-patch\\s*[\\s\\S]*?(?:```|$)/g, '')");
  });

  it('sanitizes persisted assistant messages and restores the draft card', () => {
    expect(source).toContain("if (message.role !== 'assistant') return message");
    expect(source).toContain('applyAgentDraftPatchesFromText(rawText)');
    expect(source).toContain('content: stripAgentDraftPatchBlocks(message.content)');
  });

  it('keeps machine patches out of inbox preview text', () => {
    expect(source).toContain('extractAssistantText(stripAgentDraftPatchBlocks(towerMsg.content))');
  });

  it('accepts Starter Card fields', () => {
    for (const field of ['worksFor', 'accountableOutcome', 'autonomousActions', 'approvalRequiredActions', 'onboardingChecks']) {
      expect(source).toContain(`'${field}'`);
    }
  });
});
