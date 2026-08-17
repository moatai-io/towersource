import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { canonicalizeSlashInput, loadWorkflowCommandEntries, nativeCommandEntries, normalizeSlashAlias, parseSlashInput, skillCommandEntry, uniqueSlashAliases, workflowCommandEntry } from './command-registry.js';
import { buildActiveSkillContext } from './skill/skill-context-runtime.js';
import { createSkillInvocationFromCommand, renderSkillInvocationPrompt, selectNaturalLanguageSkillInvocation } from './skill/skill-invocation.js';

describe('command-registry', () => {
  it('normalizes Korean and underscore slash aliases', () => {
    expect(normalizeSlashAlias('/스킬_이름')).toBe('/스킬_이름');
    expect(normalizeSlashAlias('회의_준비')).toBe('/회의_준비');
    expect(normalizeSlashAlias('/task   list')).toBe('/task list');
    expect(uniqueSlashAliases(['/회의_준비', '회의_준비', '/meeting-prep'])).toEqual(['/회의_준비', '/meeting-prep']);
  });

  it('builds active skill invocation prompts from matched skill commands', () => {
    const entry = skillCommandEntry({
      name: 'meeting-prep',
      description: '회의 전 준비를 돕는다',
      content: '---\ndescription: 회의 전 준비\n---\n# Meeting Prep\nDo the prep checklist.',
      scope: 'project',
    });

    const invocation = createSkillInvocationFromCommand({
      command: entry,
      matchedAlias: '/회의준비',
      skillArgs: '내일 고객 미팅',
      originalMessage: '/회의준비 내일 고객 미팅',
    });
    const context = buildActiveSkillContext(invocation);
    const prompt = context.prompt;

    expect(context).toMatchObject({
      kind: 'active_skill',
      invocationId: 'slash:meeting-prep',
      skillName: 'meeting-prep',
      trigger: 'slash',
      explicit: true,
      readState: 'loaded',
      contentChars: entry.fullContent.length,
    });
    expect(prompt).toContain('<active_skill name="meeting-prep" read_state="loaded">');
    expect(prompt).toContain('# Meeting Prep');
    expect(prompt).toContain('Original command: /회의준비 내일 고객 미팅');
    expect(prompt).toContain('Matched alias: /회의준비');
    expect(prompt).toContain('Arguments: 내일 고객 미팅');
    expect(renderSkillInvocationPrompt(invocation)).toBe(prompt);
  });

  it('marks active skill context as missing when SKILL.md content is unavailable', () => {
    const entry = skillCommandEntry({
      name: 'empty-skill',
      description: '본문 없는 스킬',
      content: '',
      scope: 'project',
    });
    const context = buildActiveSkillContext(createSkillInvocationFromCommand({
      command: entry,
      skillArgs: '',
      originalMessage: '/empty-skill',
    }));

    expect(context.readState).toBe('missing');
    expect(context.prompt).toContain('<active_skill name="empty-skill" read_state="missing">');
    expect(context.prompt).toContain('No SKILL.md content was available');
  });

  it('selects a conservative natural-language SkillInvocation only for explicit skill-like mentions', () => {
    const entry = skillCommandEntry({
      name: 'meeting-prep',
      description: '회의 준비 스킬',
      content: `---
display-name: 회의 준비
slash-aliases:
  - /회의준비
---
# Meeting Prep
Use this skill.`,
      scope: 'project',
    });

    const selected = selectNaturalLanguageSkillInvocation({
      message: '회의준비 스킬로 내일 고객 미팅 준비해줘',
      commands: [entry],
    });
    expect(selected).toMatchObject({
      skillName: 'meeting-prep',
      trigger: 'natural-language',
      explicit: false,
    });
    expect(selectNaturalLanguageSkillInvocation({
      message: '내일 고객 미팅 준비해줘',
      commands: [entry],
    })).toBeNull();
  });

  it('builds first-class command metadata from skill frontmatter', () => {
    const content = `---
description: 회의 전 준비를 돕는다. Use when: 고객 미팅 전에 자료와 참석자를 정리해야 할 때.
summary: 회의 자료와 참석자 체크리스트를 준비합니다
display-name: 회의 준비
argument-hint: "[캘린더|자료]"
slash-aliases:
  - /회의준비
  - /회의_준비
aliases: [/미팅준비, /meeting_prep]
---
# Meeting Prep
`;

    const entry = skillCommandEntry({
      name: 'meeting-prep',
      description: '회의 전 준비를 돕는다. Use when: 고객 미팅 전에 자료와 참석자를 정리해야 할 때.',
      content,
      scope: 'project',
    });

    expect(entry).toMatchObject({
      id: 'meeting-prep',
      kind: 'skill',
      canonical: '/meeting-prep',
      name: '/meeting-prep',
      displayName: '회의 준비',
      summary: '회의 자료와 참석자 체크리스트를 준비합니다',
      description: '회의 전 준비를 돕는다. Use when: 고객 미팅 전에 자료와 참석자를 정리해야 할 때.',
      argumentHint: '[캘린더|자료]',
      source: 'skills',
      scope: 'project',
      risk: 'medium',
      dispatch: { type: 'skill', target: 'meeting-prep' },
    });
    expect(entry.aliases).toEqual([
      '/meeting-prep',
      '/회의 준비',
      '/미팅준비',
      '/meeting_prep',
      '/회의준비',
      '/회의_준비',
    ]);
  });

  it('builds workflow command metadata from manifest', () => {
    const entry = workflowCommandEntry({
      manifest: {
        id: 'agent-reviewer',
        canonical: '/agent reviewer',
        aliases: ['/리뷰어', '/agent_review'],
        displayName: '리뷰어 에이전트',
        summary: '코드나 문서를 별도 리뷰 흐름으로 확인합니다.',
        description: '별도 리뷰 workflow를 시작합니다.',
        argumentHint: '[scope]',
        risk: 'medium',
        dispatch: { target: 'agent.reviewer' },
      },
      content: 'id: agent-reviewer',
      scope: 'project',
    });

    expect(entry).toMatchObject({
      id: 'workflow:agent-reviewer',
      kind: 'workflow',
      canonical: '/agent reviewer',
      name: '/agent reviewer',
      aliases: ['/agent reviewer', '/리뷰어', '/agent_review'],
      displayName: '리뷰어 에이전트',
      summary: '코드나 문서를 별도 리뷰 흐름으로 확인합니다.',
      argumentHint: '[scope]',
      source: 'workflow',
      scope: 'project',
      risk: 'medium',
      dispatch: { type: 'workflow', target: 'agent.reviewer' },
    });
  });

  it('loads workflow command manifests from project .project/commands before .tower/commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-command-registry-'));
    fs.mkdirSync(path.join(root, '.project', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(root, '.tower', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(root, '.project', 'commands', 'handoff.command.yaml'), `id: handoff-session\ncanonical: /handoff session\naliases:\n  - /인계세션\ndisplayName: 인계 세션\ndescription: 현재 대화를 새 세션으로 인계합니다.\nrisk: medium\ndispatch:\n  target: handoff.session\n`);
    fs.writeFileSync(path.join(root, '.tower', 'commands', 'duplicate.command.yaml'), `id: tower-handoff\ncanonical: /handoff session\ndescription: Managed duplicate should be shadowed\ndispatch:\n  target: tower.handoff\n`);

    const entries = loadWorkflowCommandEntries(root, 'project');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'workflow:handoff-session',
      canonical: '/handoff session',
      aliases: ['/handoff session', '/인계세션'],
      dispatch: { type: 'workflow', target: 'handoff.session' },
    });
  });

  it('parses slash input with longest alias matching and canonicalization', () => {
    const commands = nativeCommandEntries();

    expect(parseSlashInput('/agent reviewer diff 봐줘', commands)).toMatchObject({
      matchedAlias: '/agent',
      args: 'reviewer diff 봐줘',
      canonicalInput: '/agent reviewer diff 봐줘',
      command: { id: 'workflow:agent', kind: 'workflow' },
    });
    expect(parseSlashInput('/task list overdue', commands)).toMatchObject({
      matchedAlias: '/task list',
      args: 'overdue',
      canonicalInput: '/task list overdue',
      command: { id: 'native:task-list', kind: 'native' },
    });
    expect(canonicalizeSlashInput('/태스크목록 overdue', commands)).toBe('/task list overdue');
    expect(canonicalizeSlashInput('/스킬', commands)).toBe('/skills');
    expect(canonicalizeSlashInput('/압축', commands)).toBe('/compact');
  });

  it('declares UI actions for surface-opening commands', () => {
    const commands = nativeCommandEntries();

    expect(commands.find((command) => command.id === 'workflow:agent')?.uiAction).toEqual({ type: 'open_panel', panel: 'agents' });
    expect(commands.find((command) => command.id === 'native:skills')?.uiAction).toEqual({ type: 'open_panel', panel: 'skills' });
    expect(commands.find((command) => command.id === 'native:task-list')?.uiAction).toEqual({ type: 'open_view', view: 'work' });
  });

  it('only parses explicit leading slash commands', () => {
    const commands = nativeCommandEntries();

    expect(parseSlashInput('agent reviewer', commands)).toBeNull();
    expect(parseSlashInput('  agent reviewer', commands)).toBeNull();
    expect(parseSlashInput('  /agent reviewer', commands)).toMatchObject({
      command: { id: 'workflow:agent' },
      args: 'reviewer',
    });
  });

  it('does not let a shorter prefix steal a longer command', () => {
    const commands = [
      ...nativeCommandEntries(),
      workflowCommandEntry({
        manifest: {
          id: 'agent-reviewer',
          canonical: '/agent reviewer',
          description: '리뷰어 preset을 바로 실행합니다.',
          dispatch: { target: 'agent.reviewer' },
        },
        content: 'id: agent-reviewer',
        scope: 'project',
      }),
    ];

    expect(parseSlashInput('/agent reviewer diff 봐줘', commands)).toMatchObject({
      matchedAlias: '/agent reviewer',
      args: 'diff 봐줘',
      command: { id: 'workflow:agent-reviewer' },
    });
    expect(parseSlashInput('/agent review diff 봐줘', commands)).toMatchObject({
      matchedAlias: '/agent',
      args: 'review diff 봐줘',
      command: { id: 'workflow:agent' },
    });
  });

  it('keeps command boundaries and does not prefix-match partial words', () => {
    const commands = nativeCommandEntries();

    expect(parseSlashInput('/agentic reviewer', commands)).toBeNull();
    expect(parseSlashInput('/task listing', commands)?.matchedAlias).toBeUndefined();
    expect(parseSlashInput('/task list', commands)).toMatchObject({
      matchedAlias: '/task list',
      args: '',
    });
  });
});
