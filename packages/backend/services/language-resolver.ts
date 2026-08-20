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
    '- An explicit language request in the current user message takes precedence for that response. Otherwise, do not infer the response language from historical context.',
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
      return '- 모든 답변은 기본적으로 한국어로 작성하십시오. 사용자가 다른 언어로 질문하거나 명시적으로 다른 언어를 요청할 때만 해당 언어로 전환합니다.';
    case 'ja':
      return '- 既定の応答は日本語で作成してください。ユーザーが他の言語で質問したり、明示的に他の言語を要求した場合のみ切り替えます。';
    case 'zh':
      return '- 默认使用中文回答。仅当用户使用其他语言提问或明确要求时才切换。';
    case 'es':
      return '- Responde en español de forma predeterminada. Cambia de idioma solo si el usuario lo pide o escribe en otro.';
    case 'fr':
      return '- Réponds en français par défaut. Ne change de langue que si l\'utilisateur le demande explicitement ou écrit dans une autre langue.';
    case 'de':
      return '- Antworte standardmäßig auf Deutsch. Wechsle nur die Sprache, wenn der Benutzer dies ausdrücklich verlangt oder in einer anderen Sprache schreibt.';
    case 'en':
      // English is already covered by the default-language line above; keep a
      // no-op bullet so the block's shape stays consistent across languages.
      return '- Keep responses in English unless the user writes in a different language.';
    default:
      // Unknown code — stick with English guidance. resolveLanguage() should
      // rarely pass anything exotic, but be robust.
      return '- Match the language above for all prose; switch only when the user does.';
  }
}
