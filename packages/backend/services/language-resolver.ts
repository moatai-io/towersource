/**
 * Language Resolver — layered precedence for AI response language.
 *
 *   session.language > user.language > organization.language > WORKSPACE_LANGUAGE > 'ko'
 *
 * Deterministic: same input → same output. Do NOT inject timestamps, random
 * values, or any per-request variability here. This function's result is
 * embedded into the system prompt, so any gratuitous variance kills the
 * provider-side prompt cache.
 *
 * Rationale & rollout plan:
 *   workspace/decisions/2026-04-23-language-propagation-design.md
 *
 * Phase status (2026-04-24):
 *   - Phase 1 (current): WORKSPACE_LANGUAGE + 'ko' fallback are live.
 *   - Phase 2 (future):  users.language column wired in via DB layer.
 *   - Phase 3 (future):  sessions.language override surfaced in chat UI.
 */

export interface LanguageBearingUser {
  language?: string | null;
}

export interface LanguageBearingSession {
  language?: string | null;
}

export interface LanguageBearingOrganization {
  language?: string | null;
}

/**
 * Canonical human-readable label for a language code. Used when composing the
 * language policy block inside the system prompt so the model sees both the
 * ISO code and the localized name (stronger signal than code alone).
 *
 * Unknown codes fall through to their raw string — we still emit a usable
 * prompt instead of crashing.
 */
const LANGUAGE_LABELS: Record<string, { english: string; native: string }> = {
  ko: { english: 'Korean', native: '한국어' },
  en: { english: 'English', native: 'English' },
  ja: { english: 'Japanese', native: '日本語' },
  zh: { english: 'Chinese', native: '中文' },
  es: { english: 'Spanish', native: 'Español' },
  fr: { english: 'French', native: 'Français' },
  de: { english: 'German', native: 'Deutsch' },
};

/**
 * Resolve the effective language for a (user, session) pair.
 *
 * Order of precedence (first defined wins):
 *   1. session.language     — explicit per-session override (Phase 3)
 *   2. user.language        — user profile setting           (Phase 2)
 *   3. organization.language — Admin Panel workspace default
 *   4. WORKSPACE_LANGUAGE    — bootstrap/VM fallback
 *   5. 'ko'                  — hard fallback
 *
 * Returns a lowercase ISO 639-1 code. Never throws.
 */
export function resolveLanguage(
  user?: LanguageBearingUser | null,
  session?: LanguageBearingSession | null,
  organization?: LanguageBearingOrganization | null,
): string {
  const fromSession = normalize(session?.language);
  if (fromSession) return fromSession;

  const fromUser = normalize(user?.language);
  if (fromUser) return fromUser;

  const fromOrganization = normalize(organization?.language);
  if (fromOrganization) return fromOrganization;

  const fromEnv = normalize(process.env.WORKSPACE_LANGUAGE);
  if (fromEnv) return fromEnv;

  return 'ko';
}

/**
 * Compose a Language Policy block for injection into the system prompt.
 *
 * Placed inside the runtime-context section (after the stable core prompt)
 * so the stable prefix keeps caching cleanly. The block uses BOTH the target
 * language and English so models that drift mid-conversation get a strong
 * bilingual anchor.
 *
 * Callers should treat the returned string as opaque and append it verbatim.
 */
export function buildLanguagePolicyBlock(language: string): string {
  const code = normalize(language) ?? 'ko';
  const label = LANGUAGE_LABELS[code];
  const englishName = label?.english ?? code;
  const nativeName = label?.native ?? code;

  // Per-language native instruction. For unknown codes we fall back to English
  // so the prompt stays well-formed even without a translation.
  const nativeInstruction = nativeInstructionFor(code);

  return [
    '## Language Policy (HIGHEST PRIORITY)',
    `- The configured response language is **${nativeName} (${englishName} / ${code})**.`,
    `- Respond in ${englishName} by default, regardless of the language used in conversation history, memory summaries, project files, or prior assistant messages.`,
    nativeInstruction,
    '- This language policy applies to every user-visible assistant message: commentary, progress updates, pre-tool explanations, recovery notices, and final answers. Continue using the configured language after tool calls, retries, and conversation compaction; do not switch languages merely because work resumes.',
    '- Use only the language explicitly requested by the user, or the configured language if none is requested; do not switch or mix languages without a request. Necessary quotations, translations, code, and proper nouns are exceptions. Do not infer the response language from historical context.',
    '- Code identifiers, file paths, and command snippets stay as-is; translate the prose around them.',
    '- When writing Markdown bold emphasis, never put spaces inside the markers: use `**text**`, not `** text **`. For Korean/CJK, use `**텍스트**`, not `** 텍스트 **`, because some web Markdown renderers expose the raw `**` when inner spaces are present.',
  ].join('\n');
}

// ── internals ────────────────────────────────────────────────────────────

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  // Strip region suffix if someone passes 'ko-KR' or 'en_US'. Keep it lenient.
  const primary = trimmed.split(/[-_]/)[0];
  return primary || null;
}

function nativeInstructionFor(code: string): string {
  switch (code) {
    case 'ko':
      // Korean clarity rules are adapted from the ideas in snflkd/fluent-korean
      // (MIT): https://github.com/snflkd/fluent-korean. Tower keeps a compact,
      // product-wide subset here instead of installing the Claude Code plugin.
      return [
        '- 한국어로 설명할 때는 번역투·명사 나열·모호한 내부 은어를 피하고, 주체와 행동이 드러나도록 필요한 조사와 서술어를 갖춰 쓰십시오.',
        '- 본문은 자연스러운 완결 문장으로 쓰되, 제목·짧은 목록·표·UI 문구는 용도에 맞게 간결하게 작성하십시오.',
      ].join('\n');
    default:
      return ''; // The shared policy covers all languages without competing switch rules.
  }
}
