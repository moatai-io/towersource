#!/usr/bin/env node
/**
 * Apply Tower's defensive patches for @earendil-works/pi-ai.
 *
 * Why this is a script instead of patch-package:
 * npm workspace layout installs pi-ai under packages/backend/node_modules because
 * pi-coding-agent is a workspace dependency. patch-package only looks under the
 * root node_modules for @earendil-works/pi-ai and fails after the 0.75.x update.
 *
 * Patches:
 * 1. EventStream.end() / end(undefined) must resolve result(), otherwise Pi
 *    agent loops can hang forever.
 * 2. Responses message phase should be copied to streaming text blocks as early
 *    as output_item.added when upstream provides item.phase, so Tower can stream
 *    final_answer text without flashing commentary scratchpad.
 *
 * The patches are idempotent and intentionally small.
 * Test guard: packages/backend/engines/__tests__/pi-eventstream-patch.test.ts
 */
import fs from 'node:fs';
import { verifyPiBehavior } from './pi-sdk-behavior.mjs';
import path from 'node:path';

const root = process.cwd();
// Traverse the Pi dependency graph, not just the first hoisted pi-ai copy.
// Npm may install a private pi-ai below pi-coding-agent/pi-agent-core.
const seen = new Set();
const aiRoots = new Set();
function discover(modules) {
  for (const name of ['pi-ai', 'pi-coding-agent', 'pi-agent-core']) {
    const candidate = path.join(modules, '@earendil-works', name);
    if (!fs.existsSync(candidate)) continue;
    const directory = fs.realpathSync(candidate);
    if (seen.has(directory)) continue;
    seen.add(directory);
    if (name === 'pi-ai') aiRoots.add(directory);
    discover(path.join(directory, 'node_modules'));
  }
}
discover(path.join(root, 'node_modules'));
discover(path.join(root, 'packages/backend/node_modules'));
if (!aiRoots.size) {
  console.error('[pi-eventstream-patch] no pi-ai installation found');
  process.exit(1);
}

function patchEventStream(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('_resultResolved = false') && src.includes('result ?? null')) {
    console.log(`[pi-eventstream-patch] EventStream already applied: ${file}`);
    return;
  }

  const original = src;
  src = src.replace(
  '// Generic event stream class for async iteration\n',
  `// Generic event stream class for async iteration\n//\n// Tower patch — issue badlogic/pi-mono#2352 EventStream defensive fix.\n// end() / end(undefined) must resolve finalResultPromise, otherwise\n// agent-loop.js can hang forever while awaiting response.result().\n// See: workspace/decisions/2026-05-17-pi-eventstream-end-patch.md\n`,
);
// Insert the `_resultResolved = false;` field on the line immediately above
// `constructor(isComplete, extractResult) {`. The class field layout has
// shifted between 0.75.1 (resolveFinalResult was the last field) and 0.75.5
// (isComplete / extractResult fields inserted in between), so anchoring on the
// constructor line keeps the patch resilient to such reshuffles.
src = src.replace(
  /^(\s*)constructor\(isComplete, extractResult\) \{/m,
  (_match, indent) => `${indent}_resultResolved = false;\n${indent}constructor(isComplete, extractResult) {`,
);
src = src.replace(
  '        if (this.isComplete(event)) {\n            this.done = true;\n            this.resolveFinalResult(this.extractResult(event));\n        }',
  '        if (this.isComplete(event)) {\n            this.done = true;\n            this._resultResolved = true;\n            this.resolveFinalResult(this.extractResult(event));\n        }',
);
src = src.replace(
  '    end(result) {\n        this.done = true;\n        if (result !== undefined) {\n            this.resolveFinalResult(result);\n        }\n        // Notify all waiting consumers that we\'re done',
  '    end(result) {\n        this.done = true;\n        // Tower patch: always resolve finalResultPromise on end(), even if no\n        // terminal event was pushed. Prior `if (result !== undefined)` left\n        // the promise pending for end() / end(undefined).\n        if (!this._resultResolved) {\n            this._resultResolved = true;\n            this.resolveFinalResult(result ?? null);\n        }\n        // Notify all waiting consumers that we\'re done',
);

  if (src === original || !src.includes('_resultResolved = false') || !src.includes('result ?? null')) {
    console.error(`[pi-eventstream-patch] failed to patch expected EventStream patterns in ${file}`);
    throw new Error('Unrecognized SDK source; refusing patch');
  }

  fs.writeFileSync(file, src, 'utf8');
  console.log(`[pi-eventstream-patch] EventStream applied: ${file}`);
}

function patchResponsesEarlyPhase(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined)')) {
    console.log(`[pi-eventstream-patch] Responses early phase already applied: ${file}`);
    return;
  }

  const original = src;
  src = src.replace(
    '                currentBlock = { type: "text", text: "" };\n                output.content.push(currentBlock);\n                stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });',
    '                currentBlock = { type: "text", text: "", textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined) };\n                output.content.push(currentBlock);\n                stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });',
  );
  src = src.replace(
    '            const block = { type: "text", text: "" };\n            output.content.push(block);\n            const slot = { type: "text", block, contentIndex: output.content.length - 1 };',
    '            const block = { type: "text", text: "", textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined) };\n            output.content.push(block);\n            const slot = { type: "text", block, contentIndex: output.content.length - 1 };',
  );

  if (src === original || !src.includes('textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined)')) {
    console.error(`[pi-eventstream-patch] failed to patch expected Responses early phase pattern in ${file}`);
    throw new Error('Unrecognized SDK source; refusing patch');
  }

  fs.writeFileSync(file, src, 'utf8');
  console.log(`[pi-eventstream-patch] Responses early phase applied: ${file}`);
}

async function ensureBehavior(file, kind, patch, version) {
  try {
    await verifyPiBehavior(file, kind);
    console.log(`[pi-eventstream-patch] behavior already satisfied (${kind}): ${file}`);
    return;
  } catch (error) {
    if (!['0.82.1', '0.87.1'].includes(version)) {
      throw new Error(`Unreviewed Pi ${version} ${kind} behavior: ${error.message}`);
    }
  }
  const original = fs.readFileSync(file, 'utf8');
  try {
    patch(file);
    await verifyPiBehavior(file, kind);
  } catch (error) {
    fs.writeFileSync(file, original);
    throw error;
  }
}
for (const directory of aiRoots) {
  const version = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
  await ensureBehavior(path.join(directory, 'dist/utils/event-stream.js'), 'stream', patchEventStream, version);
  const responses = ['dist/api/openai-responses-shared.js', 'dist/providers/openai-responses-shared.js']
    .map((relative) => path.join(directory, relative)).filter((file) => fs.existsSync(file));
  if (!responses.length) throw new Error(`Responses adapter missing in ${directory}`);
  for (const file of responses) await ensureBehavior(file, 'responses', patchResponsesEarlyPhase, version);
}
