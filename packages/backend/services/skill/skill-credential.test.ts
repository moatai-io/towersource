import { describe, expect, it } from 'vitest';
import { evaluateSkillRequires, parseRequiresFromFrontmatter } from './skill-credential.js';

describe('parseRequiresFromFrontmatter', () => {
  it('parses cli, python, secrets, and network requirements', () => {
    const content = `---
name: gws
requires:
  cli: [gws, gh]
  python:
    - pandas
    - fitz
  secrets: [GWS_PROFILE]
  network: required
---

# gws
`;

    expect(parseRequiresFromFrontmatter(content)).toEqual({
      cli: ['gws', 'gh'],
      python: ['pandas', 'fitz'],
      secrets: ['GWS_PROFILE'],
      network: 'required',
    });
  });

  it('returns undefined when no requires block exists', () => {
    expect(parseRequiresFromFrontmatter('---\nname: basic\n---\n')).toBeUndefined();
  });
});

describe('evaluateSkillRequires', () => {
  const requires = {
    cli: ['gws', 'gh'],
    python: ['pandas', 'fitz'],
    secrets: ['GWS_PROFILE'],
    network: 'required' as const,
  };

  it('returns not-checked when no runtime environment snapshot is provided', () => {
    expect(evaluateSkillRequires(requires)).toEqual([
      {
        kind: 'cli',
        name: 'gws',
        required: true,
        status: 'not-checked',
        message: 'CLI availability has not been checked yet',
      },
      {
        kind: 'cli',
        name: 'gh',
        required: true,
        status: 'not-checked',
        message: 'CLI availability has not been checked yet',
      },
      {
        kind: 'python',
        name: 'pandas',
        required: true,
        status: 'not-checked',
        message: 'Python import availability has not been checked yet',
      },
      {
        kind: 'python',
        name: 'fitz',
        required: true,
        status: 'not-checked',
        message: 'Python import availability has not been checked yet',
      },
      {
        kind: 'secret',
        name: 'GWS_PROFILE',
        required: true,
        status: 'not-checked',
        message: 'Credential/secret availability has not been checked yet',
      },
      {
        kind: 'network',
        name: 'network',
        required: true,
        status: 'not-checked',
        message: 'Network policy has not been checked yet',
      },
    ]);
  });

  it('distinguishes ok, missing, and credential-needed with a snapshot', () => {
    expect(evaluateSkillRequires(requires, {
      cli: ['gws'],
      python: ['pandas'],
      secrets: [],
      network: 'available',
    }).map((c) => [c.kind, c.name, c.status])).toEqual([
      ['cli', 'gws', 'ok'],
      ['cli', 'gh', 'missing'],
      ['python', 'pandas', 'ok'],
      ['python', 'fitz', 'missing'],
      ['secret', 'GWS_PROFILE', 'credential-needed'],
      ['network', 'network', 'ok'],
    ]);
  });

  it('does not emit a network check for network:none', () => {
    expect(evaluateSkillRequires({ network: 'none' })).toEqual([]);
  });
});
