import { describe, expect, it, vi } from 'vitest';
import { buildSystemPromptMetrics, estimatePromptTokens, formatSystemPromptMetrics, mergeSystemPromptFragments, requireSystemPromptFragmentKeys, selectSystemPromptFragmentsForMessage } from './system-prompt-fragments.js';

vi.mock('../db/pg-repo.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => undefined),
  execute: vi.fn(async () => ({ changes: 0 })),
}));

describe('system-prompt fragment selection', () => {
  it('estimates prompt metrics and formats an observation line', () => {
    const metrics = buildSystemPromptMetrics({
      mode: 'chat',
      optionalFragments: [],
      corePrompt: 'core',
      orgPolicyPrompt: 'policy',
      runtimePrompt: 'runtime',
      sandboxPrompt: '',
      sessionIdentityPrompt: 'identity',
      staticBlock: 'core\n\npolicy',
      dynamicBlock: 'runtime\n\nidentity',
    });

    expect(metrics).toMatchObject({
      mode: 'chat',
      fragments: [],
      coreChars: 4,
      orgPolicyChars: 6,
      runtimeChars: 7,
      staticChars: 12,
      dynamicChars: 17,
      totalChars: 31,
      visualizationIncluded: true,
    });
    expect(metrics.estimatedTokens).toBe(estimatePromptTokens('core\n\npolicy\n\nruntime\n\nidentity'));
    expect(formatSystemPromptMetrics(metrics)).toContain('visualization-core=on');
  });

  it('validates and merges fixed Harness fragments with turn-selected fragments', () => {
    expect(requireSystemPromptFragmentKeys(['git', 'visualization', 'git'])).toEqual(['git', 'visualization']);
    expect(() => requireSystemPromptFragmentKeys(['unknown'])).toThrow('Unsupported system prompt fragments');
    expect(mergeSystemPromptFragments(['git'], ['visualization', 'git'])).toEqual(['git', 'visualization']);
  });

  it('keeps visualization out of turn-level keyword routing', () => {
    expect(selectSystemPromptFragmentsForMessage('이 내용을 mermaid 다이어그램으로 그려줘')).toEqual([]);
    expect(selectSystemPromptFragmentsForMessage('매출 추이를 비교해줘')).toEqual([]);
    expect(selectSystemPromptFragmentsForMessage('이 기능이 어떻게 흘러가는지 설명해줘')).toEqual([]);
    expect(selectSystemPromptFragmentsForMessage('현재 아키텍처의 상태 전이를 분석해줘')).toEqual(['durable-artifact']);
    expect(selectSystemPromptFragmentsForMessage('두 운영 방안을 비교 검토해줘')).toEqual(['durable-artifact']);
    expect(selectSystemPromptFragmentsForMessage('이 보고서를 PDF로 만들고 사이트에 게시해줘')).toEqual(['publishing', 'pdf-export']);
    expect(selectSystemPromptFragmentsForMessage('HTML 랜딩 페이지를 만들고 공개 URL로 공유해줘')).toEqual(['publishing', 'portable-html']);
    expect(selectSystemPromptFragmentsForMessage('변경사항 커밋하고 push해줘')).toEqual(['git']);
    expect(selectSystemPromptFragmentsForMessage('매주 월요일 오전 9시에 반복 실행해줘')).toEqual(['task-schedule']);
    expect(selectSystemPromptFragmentsForMessage('서브에이전트를 병렬로 붙여서 검토해줘')).toEqual(['agent-orchestration']);
    expect(selectSystemPromptFragmentsForMessage('이 GitHub 스킬팩 설치해줘')).toEqual(['external-skill-install']);
    expect(selectSystemPromptFragmentsForMessage('https://tower.tower.example.com/s/0445653e-9a05-4d24-a611-b731cdc13aac 이 세션 봐줘')).toEqual(['tower-internal-links']);
    expect(selectSystemPromptFragmentsForMessage('이 함수의 오타만 고쳐줘')).toEqual([]);
    expect(selectSystemPromptFragmentsForMessage('')).toEqual([]);
  });

  it('keeps a compact default core and loads detailed rules on demand', async () => {
    const { buildSystemPrompt } = await import('./system-prompt.js');
    const core = await buildSystemPrompt({ username: 'tester', role: 'member', optionalFragments: [] });
    const rich = await buildSystemPrompt({
      username: 'tester',
      role: 'member',
      optionalFragments: ['visualization', 'publishing', 'pdf-export', 'portable-html', 'git', 'agent-orchestration', 'durable-artifact'],
    });

    expect(core).toContain('## Core identity');
    expect(core).toContain('Project remains the technical identity, ACL, filesystem, and runtime boundary');
    expect(core).toContain('Workspace of a Primary Agent');
    expect(core).toContain('Do not invent a personality, title, authority, or promise');
    expect(core).toContain('Helper Agents are delegated specialists, not the current identity');
    expect(core).toContain('use `skills_list` to inspect Tower’s capability map like a professional');
    expect(core).toContain('If a likely skill exists, use `skills_read`');
    expect(core).toContain('## User experience and collaboration');
    expect(core).toContain('### Artifact and visual delivery');
    expect(core).toContain('Visualization is an always-on communication capability');
    expect(core).toContain('create or update a standalone Markdown file');
    expect(core).toContain('use `present_file` when available');
    expect(core).toContain('portable `~/workspace/...` path');
    expect(core).toContain('Mermaid core rules');
    expect(core).toContain('composition → stacked bar first, pie/donut only for 3–5 categories');
    expect(core).toContain('use `<br/>` rather than literal newlines');
    expect(core).toContain('never add manual fill/text colors');
    expect(core).toContain('`name="visualization"` only when exact block schemas');
    expect(core).toContain('## Audience-aware artifacts');
    expect(core).toContain('commissioning user, the speaking author/sender, and the intended reader');
    expect(core).toContain('Treat conversation history as production context, not artifact copy');
    expect(core).toContain('Treat the user as an intelligent adult');
    expect(core).toContain('Before the first tool call in a response, prefer a brief');
    expect(core).toContain('when it would help the user understand, stop, or steer the work');
    expect(core).toContain('Between tool calls, keep the user oriented when useful');
    expect(core).toContain('before a meaningful new tool-call step');
    expect(core).toContain('discovery to editing, validation, delivery, or an external action are usually worth announcing');
    expect(core).toContain('preambles proportional and optional when they add no value');
    expect(core).toContain('trivial or self-evident single action may proceed without one');
    expect(core).toContain('same-purpose tool calls can share one preamble');
    expect(core).toContain('strongly prefer naming the target and approach');
    expect(core).toContain('Do not turn action preambles into a full plan');
    expect(core).toContain('repeat the same intent');
    expect(core).toContain('Do not emit vague housekeeping');
    expect(core).toContain('After tools run, keep hidden reasoning and low-value process detail out');
    expect(core).not.toContain('narrate every subsequent tool call');
    expect(core).not.toContain('Keep routine tool preambles and internal process narration out');
    expect(core).toContain('single highest-value question');
    expect(core).toContain('Use AskUserQuestion proactively when the user’s answer is required');
    expect(core).toContain('one-at-a-time interviews');
    expect(core).toContain('use explicit options such as Yes/No or Approve/Cancel');
    expect(core).toContain('Do not make a free-text AUQ that asks the user to type only');
    expect(core).toContain('Use plain prose for open-ended reflection');
    expect(core).toContain('2026-07-14-structured-auq-for-interviews-and-decisions.md');
    expect(core).not.toContain('Use AskUserQuestion only for an immediate binary confirmation');
    expect(core).not.toContain('2026-05-07-prefer-prose-over-auq.md');
    expect(core).toContain('Use `memory_search` for concise prior-session continuity hints');
    expect(core).toContain('`session_transcript_read` when a specific session ID is already known');
    expect(core).toContain('## Safety');
    expect(core).toContain('Authorized CLI use of credentials is allowed');
    expect(core).toContain('do not intentionally copy secret values into chat, Git, source files, or reusable documents');
    expect(core).toContain('restricted to trusted users');
    expect(core).toContain('do not repeat the value, stop otherwise valid work, or recommend rotation by default');
    expect(core).toContain('value-free, searchable note');
    expect(core).toContain('Credential rotation is a user choice, not an automatic response');
    expect(core).toContain('public or broadly accessible');
    expect(core).toContain('Never rotate a credential without the user’s explicit authorization');
    expect(core).toContain('`credential_vault_input` is available');
    expect(core).toContain('do not tell the user to go enter it in Credential Vault');
    expect(core).toContain('“안전 입력창을 열어드릴까요?”');
    expect(core).toContain('wait for consent');
    expect(core).toContain('explicitly asked to register or rotate the credential');
    expect(core).toContain('provider CLI, API adapter, or credential presence check must run through `project_shell`');
    expect(core).toContain('distinguish three stages');
    expect(core).toContain('Connection is configured and allowed');
    expect(core).toContain('Credential is materialized into this specific Runtime command');
    expect(core).toContain('provider actually accepts the authentication');
    expect(core).toContain('does not prove that a Credential was deleted, expired, or never connected');
    expect(core).toContain('Provider CLIs invoked only inside Python, Node, Make, npm scripts');
    expect(core).toContain('Before retrying an external write');
    expect(core).toContain('Host `bash` intentionally does not receive Project Credential Vault values');
    expect(core).toContain('a host-bash `missing` result is not evidence');
    expect(core).toContain('confirm the Runtime Context `credential_env` summary');
    expect(core).toContain('Prefer `scope=project` so operational credentials');
    expect(core).toContain('become an Agent Connection for the current Agent');
    expect(core).toContain('legacy `scope=personal` only when the user explicitly requests');
    expect(core).toContain('not a general-purpose store for identity documents');
    expect(core).toContain('## Workspace boundaries');
    expect(core).toContain('## File handoff');
    expect(core).not.toContain('Be concise by default');
    expect(core).not.toContain('## PDF export');
    expect(core).not.toContain('## Publishing');
    expect(core).not.toContain('## Portable HTML assets');
    expect(core).not.toContain('## Git / PR');
    expect(core).not.toContain('Tower renders special code blocks');
    expect(core).not.toContain('## Durable Markdown artifacts — working copy and milestones');

    expect(rich).toContain('## PDF export');
    expect(rich).toContain('## Git / PR');
    expect(rich).toContain('## Subagents');
    expect(rich).toContain('Tower renders special code blocks');
    expect(rich).toContain('include one Mermaid diagram unless prose is genuinely clearer');
    expect(rich).toContain('pie/donut only for 3–5 part-to-whole categories');
    expect(rich).toContain('use a conservative Mermaid flowchart');
    expect(rich).toContain('## Durable Markdown artifacts — working copy and milestones');
    expect(rich).toContain('Do not impose a generic folder taxonomy');
    expect(rich).toContain('propose a clearer organization and explain the benefit');
    expect(rich).toContain('ordinary edits update the working copy');
    expect(rich).toContain('Never overwrite an immutable record');
    expect(rich).toContain('use `present_file` when available');
    expect(rich.length).toBeGreaterThan(core.length);
  });

  it('uses the read-only transcript tool for a known Tower session deep link', async () => {
    const { buildSystemPrompt } = await import('./system-prompt.js');
    const prompt = await buildSystemPrompt({
      username: 'tester',
      role: 'member',
      optionalFragments: ['tower-internal-links'],
    });

    expect(prompt).toContain('`session_transcript_read`에 session ID를 직접 넘긴다');
    expect(prompt).toContain('대상 세션을 재개하거나 메시지를 보내지 않고');
    expect(prompt).not.toContain('backend internal API 또는 PG 직접 lookup');
    expect(prompt).not.toContain('AI 가 직접 가져올 수 없습니다');
  });

  it('keeps publishing and portable HTML rules together when selected', async () => {
    const { buildSystemPrompt } = await import('./system-prompt.js');
    const prompt = await buildSystemPrompt({
      username: 'tester',
      role: 'member',
      optionalFragments: ['publishing', 'portable-html'],
    });

    expect(prompt).toContain('runtime_guide_read` with `name: "publishing"`');
    expect(prompt).toContain('publish_site');
    expect(prompt).toContain('## Portable HTML assets');
    expect(prompt).toContain('./assets/...');
    expect(prompt).toContain('data-tower-source-path');
  });

  it('bundles portable HTML rules with publishing even when only publishing intent is selected', async () => {
    const { buildSystemPrompt } = await import('./system-prompt.js');
    const prompt = await buildSystemPrompt({ username: 'tester', role: 'member', optionalFragments: ['publishing'] });

    expect(prompt).toContain('## Publishing');
    expect(prompt).toContain('## Portable HTML assets');
  });

  it('loads git and agent orchestration invariants only when requested', async () => {
    const { buildSystemPrompt } = await import('./system-prompt.js');
    const prompt = await buildSystemPrompt({
      username: 'tester',
      role: 'member',
      optionalFragments: ['git', 'agent-orchestration'],
    });

    expect(prompt).toContain('runtime_guide_read` with `name: "git"`');
    expect(prompt).toContain('git stash');
    expect(prompt).toContain('Tower-Session');
    expect(prompt).toContain('persistent_agent_create');
    expect(prompt).toContain('사용자 명시 요청 또는 활성 스킬');
    expect(prompt).toContain('runtime_guide_read` with `name: "agent-orchestration"`');
  });

  it('keeps runtime context compact and leaves project-specific wiki policy to AGENTS.md', async () => {
    const { buildSystemPrompt } = await import('./system-prompt.js');
    const prompt = await buildSystemPrompt({
      username: 'tester',
      role: 'admin',
      optionalFragments: [],
      sessionProjectRoot: '/home/tower/workspace/projects/tower-project-dev',
    });

    expect(prompt).toContain('## Runtime context');
    expect(prompt).toContain('hidden runtime context');
    expect(prompt).toContain('Follow the injected AGENTS.md project instructions');
    expect(prompt).toContain('prefer portable `~/workspace/...` paths');
    expect(prompt).not.toContain('User: tester (role: admin)');
    expect(prompt).not.toContain('## Tower development wiki-first context');
    expect(prompt).not.toContain('tower-project-dev/.wiki/index.md');
    expect(prompt).not.toContain('TOWER_ROLE');
  });
});
