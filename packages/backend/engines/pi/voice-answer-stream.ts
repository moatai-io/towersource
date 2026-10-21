/** Strict semantic bridge for voice; ordinary UI text is NOT proof of a final-answer channel. */
import { ContentAccumulator, agentMessageToTowerBlocks, parseTextSignaturePhase } from './message-adapter.js';

/** Cumulative confirmed-final snapshot, never raw deltas, commentary, tools or unknown-phase prose.
 * Providers that attach phase only at text_end remain buffered until that evidence arrives.
 */
export function confirmedVoiceAnswerSnapshot(event: any): string | undefined {
  const update = event?.assistantMessageEvent;
  const message = event?.type === 'message_update'
    && ['text_delta', 'text_end'].includes(update?.type) ? update.partial
    : event?.type === 'message_end' && event.message?.role === 'assistant' ? event.message : undefined;
  if (!message || !Array.isArray(message.content)) return undefined;
  if (message.stopReason === 'error' || message.stopReason === 'aborted'
    || message.content.some((block: any) => block?.type === 'toolCall')) return undefined;
  const finalBlocks = message.content.filter((block: any) => block?.type === 'text'
    && typeof block.text === 'string' && parseTextSignaturePhase(block) === 'final_answer');
  if (!finalBlocks.length) return undefined;
  // Reuse existing hidden-thinking/scratchpad sanitization before crossing the voice boundary.
  const accumulator = new ContentAccumulator();
  accumulator.replaceAll(agentMessageToTowerBlocks({ content: finalBlocks }));
  const text = accumulator.toTowerBlocks()
    .filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('');
  // Hold an incomplete XML-like tag rather than leaking a reasoning-tag prefix aloud.
  return text.replace(/<[^>]*$/, '');
}
