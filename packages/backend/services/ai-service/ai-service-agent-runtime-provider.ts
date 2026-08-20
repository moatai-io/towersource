/**
 * Owns: provider-neutral execution contract for one external AI Service agent turn.
 *
 * The existing Workbench provider transports commands and stdout/stderr only. It
 * must not be presented as an agent runtime because a Tower agent turn also needs
 * structured engine events, tool-result attachment, abort, and durable Session
 * correlation. A Runtime Box implementation of this contract is the next rollout
 * stage; until then the backend provider is explicit rather than disguised.
 */

import type { Engine, EngineCallbacks, RunOpts, TowerMessage } from '../../engines/types.js';

export type AIServiceAgentRuntimeProviderKind = 'backend-engine' | 'runtime-box-agent';

export interface AIServiceAgentRuntimeProvider {
  kind: AIServiceAgentRuntimeProviderKind;
  executionBoundary: 'backend-process' | 'project-runtime-box';
  run(input: {
    engine: Engine;
    sessionId: string;
    prompt: string;
    opts: RunOpts;
    callbacks: EngineCallbacks;
  }): AsyncIterable<TowerMessage>;
}

/** Current compatibility provider. Deliberately reports the backend boundary. */
export function createBackendAIServiceAgentRuntimeProvider(): AIServiceAgentRuntimeProvider {
  return {
    kind: 'backend-engine',
    executionBoundary: 'backend-process',
    run: ({ engine, sessionId, prompt, opts, callbacks }) => engine.run(sessionId, prompt, opts, callbacks),
  };
}

/** Fail closed when a caller requires full agent-loop isolation before rollout. */
export function assertRuntimeBoxAgentProvider(provider: AIServiceAgentRuntimeProvider): void {
  if (provider.kind !== 'runtime-box-agent' || provider.executionBoundary !== 'project-runtime-box') {
    throw new Error(`AI Service Runtime Box agent provider required; selected=${provider.kind}/${provider.executionBoundary}`);
  }
}
