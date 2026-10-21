// Owns Pi assistant message_update event application to the content accumulator.
// Public API: handlePiMessageUpdate.

import type { TowerContentBlock } from '../types.js';
import { agentMessageToTowerBlocks, parseTextSignaturePhase } from './message-adapter.js';
import type { ContentAccumulator } from './message-adapter.js';

export interface PiMessageUpdateResult {
  content: TowerContentBlock[];
  immediate: boolean;
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  editedFile?: { filePath: string; toolName: string };
}

export function handlePiMessageUpdate(params: {
  event: any;
  accumulator: ContentAccumulator;
}): PiMessageUpdateResult {
  const { event, accumulator } = params;
  const evt = event.assistantMessageEvent;
  let editedFile: PiMessageUpdateResult['editedFile'];
  let stopReason: PiMessageUpdateResult['stopReason'];

  if (evt?.type === 'text_delta') {
    // Responses providers are not all alike:
    // - Codex/LiteLLM can multiplex commentary/preamble text through text
    //   deltas, and phase metadata may only become available at text_end.
    //   Tower surfaces confirmed final_answer as prose and confirmed commentary
    //   as progress bubbles. Phase-less deltas for these providers wait for
    //   text_end so scratchpad-shaped commentary does not flash and disappear.
    // - Direct OpenAI/Azure Responses output_text deltas are already user-facing;
    //   keep streaming phase-less deltas there so mobile does not collapse into
    //   a final burst.
    const provider = String(evt.partial?.provider || evt.partial?.model?.provider || '');
    const requiresConfirmedPhase = /^(litellm-responses|openai-codex)$/i.test(provider);
    const streamingBlock = Array.isArray(evt.partial?.content) ? evt.partial.content[evt.contentIndex] : undefined;
    const phase = parseTextSignaturePhase(streamingBlock);
    if (phase === 'final_answer') {
      // The SDK partial is cumulative. Reconcile it as soon as finality is
      // known: earlier deltas may have been withheld while phase was missing.
      // Appending only the latest delta would drop that prefix until text_end.
      const partial = requiresConfirmedPhase ? {
        ...evt.partial,
        content: evt.partial.content.filter((block: any) => block.type !== 'text'
          || ['final_answer', 'commentary'].includes(parseTextSignaturePhase(block) || '')),
      } : evt.partial;
      accumulator.replaceAll(agentMessageToTowerBlocks(partial));
    }
    else if (phase === 'commentary') accumulator.appendCommentary(evt.delta);
    else if (phase) {
      // Future non-final phases stay hidden unless explicitly modeled.
    } else if (!requiresConfirmedPhase) accumulator.appendText(evt.delta);
  } else if (evt?.type === 'text_end' && evt.partial) {
    accumulator.replaceAll(agentMessageToTowerBlocks(evt.partial));
  } else if (evt?.type === 'thinking_delta') {
    accumulator.appendThinking(evt.delta);
  } else if (evt?.type === 'toolcall_end' && evt.toolCall) {
    accumulator.addToolUse(evt.toolCall);
    const toolName = String(evt.toolCall.name || '').toLowerCase();
    if (toolName === 'write' || toolName === 'edit' || toolName === 'notebook_edit' || toolName === 'notebookedit') {
      const args = (evt.toolCall.arguments ?? {}) as Record<string, any>;
      const filePath = args.path || args.file_path || args.notebook_path;
      if (typeof filePath === 'string' && filePath) {
        editedFile = { filePath, toolName: evt.toolCall.name || toolName };
      }
    }
  } else if (evt?.type === 'done' || evt?.type === 'error') {
    stopReason = evt.reason;
  }

  return {
    content: accumulator.toTowerBlocks(),
    immediate: evt?.type === 'toolcall_end' || evt?.type === 'done' || evt?.type === 'error',
    stopReason,
    editedFile,
  };
}
