import type { AgentOptions } from '@earendil-works/pi-agent-core';

type Hook = NonNullable<AgentOptions['afterToolCall']>;

/** Tower provenance runs first; native SDK image normalization/extensions run
 * last, before the final result enters history. Preserve omitted override fields. */
export function installPiAfterToolCallHook(agent: { afterToolCall?: Hook }, tower: Hook): void {
  const native = agent.afterToolCall;
  agent.afterToolCall = async function (context, signal) {
    const first = await tower.call(agent, context, signal);
    if (!native) return first;
    const result = { ...context.result };
    if (first) {
      for (const [key, value] of Object.entries(first)) {
        if (value !== undefined) (result as any)[key] = value;
      }
    }
    const second = await native.call(agent, {
      ...context, result, isError: first?.isError ?? context.isError,
    }, signal);
    if (!second) return first;
    const merged = { ...first };
    for (const [key, value] of Object.entries(second)) {
      if (value !== undefined) (merged as any)[key] = value;
    }
    return merged;
  };
}
