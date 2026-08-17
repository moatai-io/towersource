// Owns: Agent Session UI classification and human-input provenance.
// Public API: HUMAN_CHAT_SOURCE_TYPE, humanChatMetadata, humanTouchedSql.
// See README.md.

export const HUMAN_CHAT_SOURCE_TYPE = 'human_chat' as const;

/** Metadata attached only to direct UI chat input. */
export function humanChatMetadata(): { sourceType: typeof HUMAN_CHAT_SOURCE_TYPE } {
  return { sourceType: HUMAN_CHAT_SOURCE_TYPE };
}

/**
 * SQL predicate for direct human participation.
 *
 * Primary signal: explicit `metadata.sourceType = 'human_chat'`.
 * Legacy fallback: older direct UI messages had username but empty metadata.
 *
 * Do not use `role = 'user'` or `username IS NOT NULL` alone: agent spawn/send/wake
 * messages intentionally use user-role rows and usernames for engine/UI provenance.
 */
export function humanTouchedSql(messageAlias = 'm'): string {
  return `(
        ${messageAlias}.role = 'user'
        AND ${messageAlias}.username IS NOT NULL
        AND (
          ${messageAlias}.metadata->>'sourceType' = '${HUMAN_CHAT_SOURCE_TYPE}'
          OR COALESCE(${messageAlias}.metadata, '{}'::jsonb) = '{}'::jsonb
        )
      )`;
}
