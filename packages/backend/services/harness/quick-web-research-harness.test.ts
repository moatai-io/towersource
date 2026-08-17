import { describe, expect, it } from 'vitest';
import { QUICK_WEB_RESEARCH_HARNESS } from './quick-web-research-harness.js';

describe('quick-web-research Harness contract', () => {
  it('has a minimal, immutable web-only capability surface', () => {
    expect(QUICK_WEB_RESEARCH_HARNESS).toMatchObject({
      id: 'quick-web-research',
      version: 1,
      engine: 'pi',
      defaultModel: 'litellm-responses/smart',
      allowedModels: ['litellm-responses/smart'],
      capabilityIds: ['web.fetch', 'web.search'],
      sandboxMode: 'none',
      runtimeProfileId: 'web-only',
    });
    expect(Object.isFrozen(QUICK_WEB_RESEARCH_HARNESS)).toBe(true);
    expect(QUICK_WEB_RESEARCH_HARNESS.prompt).toMatchObject({
      includePlatformKernel: true,
      includeAgentIdentity: true,
      includeProjectInstructions: false,
      includeMemory: false,
      includeSkills: false,
    });
  });

  it('does not declare filesystem, orchestration, session, or publication capabilities', () => {
    const capabilities = QUICK_WEB_RESEARCH_HARNESS.capabilityIds.join(' ');
    expect(capabilities).not.toMatch(/workspace|filesystem|bash|runtime|sandbox/);
    expect(capabilities).not.toMatch(/spawn|worker|agent|session|conversation|memory/);
    expect(capabilities).not.toMatch(/publish|schedule|issue|approval|credential/);
  });
});
