// Owns: Common async-iterator execution mechanics for background Agent Session turns.
// Public API: runSessionTurnStream. See README.md.

import type {
  Engine,
  EngineCallbacks,
  RunOpts,
  TowerMessage,
} from '../../engines/types.js';
import { recordPiUsageEvent } from '../ai-usage/usage-ledger.js';
import { isModelPolicyId } from '../ai/litellm-model-catalog.js';

/** Acknowledges that control reached the engine async iterator's first `next()` call. */
export interface SessionTurnStartAcknowledgement {
  acknowledge(): void;
  fail(error: unknown): void;
}

export interface RunSessionTurnStreamInput {
  sessionId: string;
  prompt: string;
  engine: Engine;
  runOpts: RunOpts;
  callbacks: EngineCallbacks;
  startAcknowledgement?: SessionTurnStartAcknowledgement;
  onMessage(message: TowerMessage): void | Promise<void>;
}

export interface SessionTurnStreamResult {
  yieldedMessages: number;
  lastAssistantText: string;
  terminalMessage?: Extract<TowerMessage, { type: 'turn_terminal' }>;
  engineDoneMessage?: Extract<TowerMessage, { type: 'engine_done' }>;
}

function assistantText(message: TowerMessage): string {
  if (message.type !== 'assistant') return '';
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Run one prepared Session turn through a single iterator contract.
 *
 * Callers retain policy ownership: durable root-turn registration, terminal
 * settlement, report routing, queue draining, and UI status transitions.
 */
export async function runSessionTurnStream(
  input: RunSessionTurnStreamInput,
): Promise<SessionTurnStreamResult> {
  let yieldedMessages = 0;
  let lastAssistantText = '';
  let terminalMessage: SessionTurnStreamResult['terminalMessage'];
  let engineDoneMessage: SessionTurnStreamResult['engineDoneMessage'];

  try {
    const stream = input.engine.run(
      input.sessionId,
      input.prompt,
      input.runOpts,
      input.callbacks,
    )[Symbol.asyncIterator]();
    let nextMessage = stream.next();
    input.startAcknowledgement?.acknowledge();

    for (;;) {
      const current = await nextMessage;
      if (current.done) break;
      nextMessage = stream.next();
      yieldedMessages += 1;

      const message = current.value;
      const text = assistantText(message);
      if (text) lastAssistantText = text;
      if (message.type === 'turn_terminal') terminalMessage = message;
      if (message.type === 'engine_done') engineDoneMessage = message;

      if (message.type === 'turn_done' && input.runOpts.rootTurnId && input.runOpts.model?.startsWith('litellm-responses/')) {
        await recordPiUsageEvent({
          sessionId: input.sessionId,
          rootTurnId: input.runOpts.rootTurnId,
          messageId: message.msgId,
          usage: message.usage,
          requestedModel: input.runOpts.model,
          modelPolicyId: input.runOpts.modelPolicyId ?? (isModelPolicyId(input.runOpts.model) ? input.runOpts.model!.split('/')[1] : undefined),
          modelPolicyRevision: input.runOpts.modelPolicyRevision,
        }).catch((error: any) => {
          console.warn(`[session-turn-runner] AI usage ledger write failed: session=${input.sessionId.slice(0, 8)} error=${error?.message || error}`);
        });
      }

      await input.onMessage(message);
    }

    return {
      yieldedMessages,
      lastAssistantText,
      terminalMessage,
      engineDoneMessage,
    };
  } catch (error) {
    input.startAcknowledgement?.fail(error);
    throw error;
  }
}
