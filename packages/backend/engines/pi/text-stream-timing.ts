/** Content-free, per-run SDK text timing. No provider payloads or text are emitted. */
import { parseTextSignaturePhase } from './message-adapter.js';

export function createTextStreamTiming(now: () => number = Date.now) {
  const started = now();
  const first: Record<string, number> = {};
  let deltas = 0;
  let unconfirmedDeltas = 0;
  const mark = (stage: string) => { first[stage] ??= Math.max(0, now() - started); };
  return {
    observe(event: any) {
      const update = event?.assistantMessageEvent;
      if (update?.type !== 'text_delta' && update?.type !== 'text_end') return;
      const block = update.partial?.content?.[update.contentIndex];
      const phase = parseTextSignaturePhase(block);
      if (update.type === 'text_delta') {
        deltas++;
        mark('firstDeltaMs');
        if (!phase) { unconfirmedDeltas++; mark('firstUnknownPhaseMs'); }
      } else mark('firstTextEndMs');
      if (phase === 'final_answer') mark('firstFinalPhaseMs');
    },
    visible() { mark('firstVisibleSnapshotMs'); },
    snapshot() { return { ...first, deltas, unconfirmedDeltas }; },
  };
}
