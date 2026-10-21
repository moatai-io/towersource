/**
 * Verify the Tower patch for @earendil-works/pi-ai EventStream.end() is
 * applied to node_modules. Catches "npm install ran without postinstall"
 * (e.g. someone used `npm ci --ignore-scripts`) and any future SDK upgrade
 * that re-introduces the upstream bug.
 *
 * Bug (issue badlogic/pi-mono#2352):
 *   end() / end(undefined) → `if (result !== undefined)` skips →
 *   finalResultPromise stays pending → agent-loop's `await response.result()`
 *   hangs forever.
 *
 * Patch:
 *   _resultResolved flag + resolve with null fallback on end().
 *
 * Decision: workspace/decisions/2026-05-17-pi-eventstream-end-patch.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

function findPiAiFile(relativePath: string): string {
  const candidates: string[] = [];
  let cursor = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(cursor, 'packages/backend/node_modules/@earendil-works/pi-ai', relativePath));
    candidates.push(path.join(cursor, 'node_modules/@earendil-works/pi-ai', relativePath));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`pi-ai file not found: ${relativePath}`);
  return found;
}

describe('Pi SDK EventStream.end() patch (issue #2352)', () => {
  it('result() resolves after end() with NO arg', async () => {
    const stream = createAssistantMessageEventStream();
    // Pull events in background (none will arrive); patch path is end() only.
    const consumer = (async () => {
      const events: any[] = [];
      for await (const e of stream) events.push(e);
      return events;
    })();

    stream.end(); // no result argument

    // Without the patch, result() never resolves → this would hang the test
    // forever (vitest would kill after default timeout). With the patch it
    // resolves to null.
    const result = await Promise.race([
      stream.result(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT — patch missing')), 1000)),
    ]);
    expect(result).toBeNull();
    await consumer;
  });

  it('result() resolves after end(undefined)', async () => {
    const stream = createAssistantMessageEventStream();
    const consumer = (async () => {
      for await (const _ of stream) { /* drain */ }
    })();
    stream.end(undefined);
    const result = await Promise.race([
      stream.result(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT — patch missing')), 1000)),
    ]);
    expect(result).toBeNull();
    await consumer;
  });

  it('normal path (push done event then end) still resolves to the event message', async () => {
    const stream = createAssistantMessageEventStream();
    const consumer = (async () => {
      for await (const _ of stream) { /* drain */ }
    })();
    const fakeMessage = { role: 'assistant', content: [], stopReason: 'stop' } as any;
    stream.push({ type: 'done', reason: 'stop', message: fakeMessage } as any);
    stream.end();
    const result = await stream.result();
    expect(result).toEqual(fakeMessage);
    await consumer;
  });

  it('Responses adapter exposes message phase on text_start when upstream provides it', () => {
    let file: string;
    try {
      file = findPiAiFile('dist/api/openai-responses-shared.js');
    } catch {
      file = findPiAiFile('dist/providers/openai-responses-shared.js');
    }
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toContain('textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined)');
  });

  it('double-end() is harmless (idempotent resolve)', async () => {
    const stream = createAssistantMessageEventStream();
    const consumer = (async () => {
      for await (const _ of stream) { /* drain */ }
    })();
    stream.end();
    stream.end(); // should not throw, should not re-resolve
    const result = await stream.result();
    expect(result).toBeNull();
    await consumer;
  });
});

// Exercise every reachable SDK copy: a root-only assertion missed production's
// private dependency beneath pi-coding-agent.
describe('nested Pi runtime SDK patches', () => {
  const seen = new Set<string>();
  const copies: string[] = [];
  function walk(modules: string) {
    for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent']) {
      const candidate = path.join(modules, '@earendil-works', name);
      if (!fs.existsSync(candidate)) continue;
      const directory = fs.realpathSync(candidate);
      if (seen.has(directory)) continue;
      seen.add(directory);
      if (name === 'pi-ai') copies.push(directory);
      walk(path.join(directory, 'node_modules'));
    }
  }
  walk(path.join(process.cwd(), 'node_modules'));
  walk(path.join(process.cwd(), 'packages/backend/node_modules'));
  it('discovers at least one SDK', () => expect(copies.length).toBeGreaterThan(0));
  for (const directory of copies) {
    it(`preserves early phase and resolves end in ${path.relative(process.cwd(), directory)}`, async () => {
      const adapter = ['api', 'providers'].map((folder) => path.join(directory, 'dist', folder, 'openai-responses-shared.js'))
        .find((file) => fs.existsSync(file))!;
      const { processResponsesStream } = await import(pathToFileURL(adapter).href);
      const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(directory, 'dist/utils/event-stream.js')).href);
      const stream = createAssistantMessageEventStream();
      stream.end();
      expect(await stream.result()).toBeNull();
      const output: any = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} } };
      let earlyPhase: string | undefined;
      async function* events() {
        yield { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'fixture', phase: 'final_answer' } };
        yield { type: 'response.output_text.delta', output_index: 0, delta: 'hello' };
        yield { type: 'response.completed', response: { status: 'completed', output: [] } };
      }
      await processResponsesStream(events(), output, { push(event: any) {
        if (event.type === 'text_delta') earlyPhase = JSON.parse(event.partial.content[event.contentIndex].textSignature || '{}').phase;
      } }, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      expect(earlyPhase).toBe('final_answer');
    });
  }
});
