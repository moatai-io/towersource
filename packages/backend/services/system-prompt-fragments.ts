/**
 * System Prompt Fragment Selector — keeps task-specific operating instructions
 * out of the default prompt while preserving compact safety/permission rules.
 */

export type SystemPromptFragmentKey =
  | 'visualization'
  | 'publishing'
  | 'pdf-export'
  | 'portable-html'
  | 'tower-internal-links'
  | 'task-schedule'
  | 'git'
  | 'agent-orchestration'
  | 'external-skill-install'
  | 'durable-artifact'
  | 'voice-spoken-korean';

export interface SystemPromptBuildMetrics {
  mode: 'chat' | 'task';
  fragments: SystemPromptFragmentKey[];
  coreChars: number;
  orgPolicyChars: number;
  runtimeChars: number;
  sandboxChars: number;
  sessionIdentityChars: number;
  staticChars: number;
  dynamicChars: number;
  totalChars: number;
  estimatedTokens: number;
  visualizationIncluded: boolean;
}

// Visualization is an always-on reasoning capability in the compact core.
// Do not add turn-level keyword routing here: semantic regexes become a second,
// brittle decision engine. The legacy fragment key remains valid for fixed
// Harness compatibility, but ordinary turns rely on the model's core judgment.
const FRAGMENT_RULES: ReadonlyArray<{ key: SystemPromptFragmentKey; pattern: RegExp }> = [
  { key: 'publishing', pattern: /(?:\bpublish(?:ing)?\b|\bdeploy\s+(?:a\s+)?site\b|\bshare\s+(?:the\s+)?(?:site|page|dashboard)\b|퍼블리시|게시(?:해|하|해서|하고|하기|물로)|사이트\s*배포|웹(?:페이지|사이트).*공유|공개\s*URL|SEO|unlisted)/i },
  { key: 'pdf-export', pattern: /(?:print[- ]ready|printable|인쇄용|(?:PDF|pdf)(?:로|\s*(?:만들|생성|출력|변환|내보내|export))|(?:보고서|제안서|발표자료|슬라이드).{0,30}(?:만들|작성|제작|완성|최종본))/i },
  { key: 'portable-html', pattern: /(?:\bHTML\b|\bCSS\b|랜딩\s*페이지|웹\s*페이지|웹사이트|대시보드)/i },
  { key: 'tower-internal-links', pattern: /https?:\/\/[^\s/]+\/s\/[0-9a-f]{8}-[0-9a-f-]{27,}/i },
  { key: 'task-schedule', pattern: /(?:\/task-schedule|\bschedule\b|\bremind(?:er)?\b|태스크\s*(?:만들|목록|등록)|할일\s*(?:추가|등록)|스케줄|예약\s*(?:실행|해줘)|매일|매주|반복\s*실행|정기\s*실행|(?:월|화|수|목|금|토|일)요일.{0,20}(?:알려|리마인드|실행|예약))/i },
  { key: 'git', pattern: /(?:\bgit\b|\bcommit\b|\bpush\b|\bpull request\b|\bPR\b|\bmerge\b|\brebase\b|\btag\b|커밋|푸시|풀리퀘|브랜치|머지|리베이스|태그)/i },
  { key: 'agent-orchestration', pattern: /(?:\bsubagent\b|\bmulti-agent\b|\bspawn(?:ed)?\s+session\b|\bagent\s+team\b|서브에이전트|멀티.?에이전트|에이전트\s*(?:팀|위임)|별도\s*세션|병렬(?:로|\s*검토|\s*분석|\s*조사|\s*세션)|세션\s*spawn)/i },
  { key: 'external-skill-install', pattern: /(?:\bskill\s*(?:pack)?\s*install\b|\binstall\b.*\b(?:skill|github|repository|repo)\b|외부\s*스킬|스킬팩|GitHub.*설치|(?:스킬|skill).*(?:저장소|repository|repo).*(?:설치|clone|복제)|(?:저장소|repository|repo).*(?:설치|clone|복제))/i },
  { key: 'durable-artifact', pattern: /(?:\b(?:strategy|plan|proposal|specification|requirements?|design\s+doc|decision\s+record|research\s+report|implementation\s+plan)\b|기획(?:안|서|을|해|하|이|과|서)?|아키텍처|전략(?:안|을|이|과|서)?|설계(?:안|서|를|해|하|와|도)?|실행\s*계획|요구사항|비교\s*검토|상세\s*분석|정책\s*(?:초안|안)|(?:의사결정|결정)\s*(?:문서|기록)|조사\s*결과.{0,12}정리|연구\s*보고서|검토\s*보고서|운영\s*계획|제안\s*논리)/i },
];

export function selectSystemPromptFragmentsForMessage(message: string | undefined | null): SystemPromptFragmentKey[] {
  const text = message?.trim() || '';
  if (!text) return [];
  return FRAGMENT_RULES.filter(({ pattern }) => pattern.test(text)).map(({ key }) => key);
}

const SYSTEM_PROMPT_FRAGMENT_KEYS = new Set<SystemPromptFragmentKey>([
  'visualization', // Legacy fixed Harness compatibility; always-on core for ordinary turns.
  'voice-spoken-korean', // Internal runtime-selected voice turn fragment; never keyword-routed from user text.
  ...FRAGMENT_RULES.map(({ key }) => key),
]);

/** Validate publisher-owned fixed fragment ids against Tower's registered prompt components. */
export function requireSystemPromptFragmentKeys(value: readonly string[]): SystemPromptFragmentKey[] {
  const normalized = [...new Set(value.map((item) => item.trim()).filter(Boolean))].sort();
  const unsupported = normalized.filter((item) => !SYSTEM_PROMPT_FRAGMENT_KEYS.has(item as SystemPromptFragmentKey));
  if (unsupported.length > 0) throw new Error(`Unsupported system prompt fragments: ${unsupported.join(', ')}`);
  return normalized as SystemPromptFragmentKey[];
}

/** Merge immutable Harness fragments with turn-selected fragments deterministically. */
export function mergeSystemPromptFragments(
  harnessFragments: readonly SystemPromptFragmentKey[],
  turnFragments: readonly SystemPromptFragmentKey[] | undefined,
): SystemPromptFragmentKey[] {
  return [...new Set([...harnessFragments, ...(turnFragments ?? [])])].sort();
}

export function hasSystemPromptFragment(
  fragments: readonly SystemPromptFragmentKey[] | undefined,
  key: SystemPromptFragmentKey,
  defaultValue = false,
): boolean {
  return fragments ? fragments.includes(key) : defaultValue;
}

/** Rough provider-agnostic estimate; Korean/CJK-heavy prompts are closer to 1 char/token than ASCII. */
export function estimatePromptTokens(text: string): number {
  let estimated = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    estimated += code > 0x7f ? 1 : 0.25;
  }
  return Math.ceil(estimated);
}

export function buildSystemPromptMetrics(parts: {
  mode: 'chat' | 'task';
  optionalFragments?: readonly SystemPromptFragmentKey[];
  corePrompt: string;
  orgPolicyPrompt: string;
  runtimePrompt: string;
  sandboxPrompt: string;
  sessionIdentityPrompt: string;
  staticBlock: string;
  dynamicBlock: string;
}): SystemPromptBuildMetrics {
  const fragments = [...(parts.optionalFragments ?? [])];
  const totalText = [parts.staticBlock, parts.dynamicBlock].filter(Boolean).join('\n\n');
  return {
    mode: parts.mode,
    fragments,
    coreChars: parts.corePrompt.length,
    orgPolicyChars: parts.orgPolicyPrompt.length,
    runtimeChars: parts.runtimePrompt.length,
    sandboxChars: parts.sandboxPrompt.length,
    sessionIdentityChars: parts.sessionIdentityPrompt.length,
    staticChars: parts.staticBlock.length,
    dynamicChars: parts.dynamicBlock.length,
    totalChars: totalText.length,
    estimatedTokens: estimatePromptTokens(totalText),
    visualizationIncluded: true,
  };
}

export function formatSystemPromptMetrics(metrics: SystemPromptBuildMetrics): string {
  const fragments = metrics.fragments.length ? metrics.fragments.join(',') : 'none';
  return [
    `[system-prompt] mode=${metrics.mode}`,
    `fragments=${fragments}`,
    `visualization-core=${metrics.visualizationIncluded ? 'on' : 'off'}`,
    `chars=${metrics.totalChars}`,
    `estTokens=${metrics.estimatedTokens}`,
    `static=${metrics.staticChars}`,
    `dynamic=${metrics.dynamicChars}`,
    `core=${metrics.coreChars}`,
    `runtime=${metrics.runtimeChars}`,
  ].join(' ');
}
