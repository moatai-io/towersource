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
