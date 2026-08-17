import type { ChatMessage } from '../stores/chat-store';

/**
 * Hide DB-recovered mid-turn Pi steer messages until the engine reports the
 * exact injection point via steer_delivered.
 *
 * The backend persists a steered user message immediately for durability, but
 * the live UI intentionally renders it only when Pi has consumed it. During
 * reconnect/session-refresh DB merges, that persisted row can otherwise appear
 * early while the pending steer chip is still visible.
 */
export function filterPendingSteerMessages<T extends Pick<ChatMessage, 'id' | 'role'>>(
  messages: T[],
  pendingInjections: readonly { id: string }[] | undefined,
  isStreaming: boolean,
): T[] {
  if (!isStreaming || !pendingInjections || pendingInjections.length === 0) return messages;
  const pendingIds = new Set(pendingInjections.map((item) => item.id));
  return messages.filter((message) => !(message.role === 'user' && pendingIds.has(message.id)));
}
