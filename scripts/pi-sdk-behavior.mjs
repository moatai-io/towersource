// Behavioral contracts, intentionally independent of patch source markers.
import { pathToFileURL } from 'node:url';
let generation = 0;
export async function verifyPiBehavior(file, kind) {
  const module = await import(`${pathToFileURL(file).href}?towerProbe=${++generation}`);
  if (kind === 'stream') {
    const bounded = async (promise) => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('result timeout')), 150); })]); }
      finally { clearTimeout(timer); }
    };
    for (const mode of ['empty', 'undefined', 'terminal', 'explicit']) {
      const stream = module.createAssistantMessageEventStream();
      const terminal = { role: 'assistant', content: [], stopReason: 'stop' };
      if (mode === 'terminal') stream.push({ type: 'done', reason: 'stop', message: terminal });
      if (mode === 'explicit') stream.end(terminal);
      else if (mode === 'undefined') stream.end(undefined);
      else stream.end();
      stream.end();
      const result = await bounded(stream.result());
      if (mode === 'terminal' || mode === 'explicit') {
        if (result !== terminal) throw new Error('terminal result overwritten');
      } else if (result != null) throw new Error('unexpected empty result');
      await bounded((async () => { for await (const _ of stream) { /* drain */ } })());
    }
    return;
  }
  for (const phase of ['final_answer', 'commentary', undefined]) {
    let observed = false;
    const output = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} } };
    async function* events() {
      yield { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'fixture', ...(phase ? { phase } : {}) } };
      yield { type: 'response.output_text.delta', output_index: 0, delta: 'hello' };
      yield { type: 'response.completed', response: { status: 'completed', output: [] } };
    }
    await module.processResponsesStream(events(), output, { push(event) {
      if (event.type !== 'text_delta') return;
      observed = true;
      const signature = event.partial.content[event.contentIndex].textSignature;
      const actual = signature?.startsWith('{') ? JSON.parse(signature).phase : undefined;
      if (actual !== phase) throw new Error('early phase mismatch');
    } }, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    if (!observed) throw new Error('missing text delta');
  }
}
