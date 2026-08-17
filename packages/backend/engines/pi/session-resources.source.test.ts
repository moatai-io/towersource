import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './session-resources.ts'), 'utf8');
const systemPrompt = fs.readFileSync(path.resolve(import.meta.dirname, '../../services/system-prompt.ts'), 'utf8');

describe('Pi Harness prompt execution contract', () => {
  it('merges registered Harness fragments with turn-selected fragments', () => {
    expect(source).toContain('requireSystemPromptFragmentKeys(harness.prompt.fragments)');
    expect(source).toContain('mergeSystemPromptFragments(harnessFragments, opts.systemPromptFragments)');
    expect(source).toContain('optionalFragments: systemPromptFragments');
  });

  it('removes Agent/Profile and Session identity when the Harness excludes identity', () => {
    expect(source).toContain('projectId: includeAgentIdentity && !opts.serviceIdentityPrompt ? opts.projectId : undefined');
    expect(source).toContain('sessionId: includeAgentIdentity && !opts.serviceIdentityPrompt ? sessionId : undefined');
    expect(source).toContain('includeSessionIdentity: includeAgentIdentity && !opts.serviceIdentityPrompt');
    expect(systemPrompt).toContain("user.includeSessionIdentity === true ? buildSessionIdentityPrompt(user) : Promise.resolve('')");
  });

  it('uses a server-owned Service identity without loading the source Project Primary Agent', () => {
    expect(source).toContain('serviceIdentityPrompt: includeAgentIdentity ? opts.serviceIdentityPrompt : undefined');
    expect(systemPrompt).toContain('user.serviceIdentityPrompt');
    expect(systemPrompt).toContain('? Promise.resolve(user.serviceIdentityPrompt)');
  });

  it('normalizes retired Runtime Box and project_shell wording only for Project sessions', () => {
    expect(source).toContain('export function normalizeProjectBashPrompt');
    expect(source).toContain('opts.projectId ? normalizeProjectBashPrompt(rawTowerPrompt) : rawTowerPrompt');
    expect(source).toContain('Use `bash` for Project commands');
    expect(source).toContain('Do not choose or infer Worker, host, Runtime Box, container, or transport');
    expect(source).toContain('Never switch to another execution plane automatically');
  });

  it('continues to enforce Project instructions, memory, and skills independently', () => {
    expect(source).toContain('harness.prompt.includeMemory');
    expect(source).toContain('!harness.prompt.includeSkills');
    expect(source).toContain('harness.prompt.includeProjectInstructions ? undefined');
  });
});
