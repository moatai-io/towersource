#!/usr/bin/env node
// Shared local/Nix/Fleet gate: shrinkwrap copies must agree and all be patched.
// Read-only; physical deduplication is deliberately not attempted.
import fs from 'node:fs';
import { verifyPiBehavior } from './pi-sdk-behavior.mjs';
import path from 'node:path';
const copies = new Map();
const visited = new Set();
function walk(modules) {
  for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent']) {
    const candidate = path.join(modules, '@earendil-works', name);
    if (!fs.existsSync(candidate)) continue;
    const directory = fs.realpathSync(candidate);
    if (visited.has(directory)) continue;
    visited.add(directory);
    const list = copies.get(name) || [];
    list.push(directory); copies.set(name, list);
    walk(path.join(directory, 'node_modules'));
  }
}
walk(path.resolve('node_modules'));
walk(path.resolve('packages/backend/node_modules'));
let failed = false;
const versions = new Set();
for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent']) {
  const list = copies.get(name) || [];
  if (!list.length) { failed = true; console.error(`[pi-sdk-runtime] missing ${name}`); }
  for (const directory of list) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    versions.add(manifest.version);
    if (name !== 'pi-ai') continue;
    const adapters = ['api', 'providers'].map((folder) => path.join(directory, 'dist', folder, 'openai-responses-shared.js'))
      .filter((file) => fs.existsSync(file));
    const stream = path.join(directory, 'dist/utils/event-stream.js');
    try {
      if (!adapters.length) throw new Error('missing adapter');
      await verifyPiBehavior(stream, 'stream');
      for (const adapter of adapters) await verifyPiBehavior(adapter, 'responses');
    } catch (error) {
      failed = true;
      console.error('[pi-sdk-runtime] failed behavior in ' + path.relative(process.cwd(), directory) + ': ' + error.message);
    }
  }
}
if (versions.size !== 1) { failed = true; console.error('[pi-sdk-runtime] inconsistent release train'); }
if (failed) process.exitCode = 1;
else console.log('[pi-sdk-runtime] all reachable Pi copies have matching versions and required patches');
