import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/check-pi-sdk-runtime.mjs');
describe('shared runtime SDK gate', () => {
  it('rejects unpatched nested copies and mismatched versions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gate-'));
    const put = (relative: string, text: string) => {
      const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    };
    const pkg = (base: string, version = '0.82.1', patched = true) => {
      put(base + '/package.json', JSON.stringify({ version, type: "module" }));
      if (!base.endsWith('/pi-ai')) return;
      put(base + '/dist/utils/event-stream.js', fs.readFileSync('node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js', 'utf8'));
      put(base + '/dist/api/openai-responses-shared.js', patched ? `export async function processResponsesStream(events, output, stream) { let phase; for await (const e of events) { if(e.item) phase=e.item.phase; if(e.delta) { output.content=[{textSignature:JSON.stringify({phase})}]; stream.push({type:'text_delta',partial:output,contentIndex:0}); } } }` : 'unpatched');
    };
    const run = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    try {
      for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent']) pkg('node_modules/@earendil-works/' + name);
      expect(run().status).toBe(0);
      // Marker-free compatible upstream code is accepted without rewriting it.
      const apply = path.resolve('scripts/apply-pi-eventstream-patch.mjs');
      const adapter = path.join(root, 'node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js');
      const before = fs.readFileSync(adapter, 'utf8');
      expect(spawnSync(process.execPath, [apply], {cwd:root}).status).toBe(0);
      expect(fs.readFileSync(adapter, 'utf8')).toBe(before);
      pkg('node_modules/@earendil-works/pi-ai', '9.0.0', false);
      expect(spawnSync(process.execPath, [apply], {cwd:root}).status).toBe(1);
      expect(fs.readFileSync(adapter, 'utf8')).toBe('unpatched');
      pkg('node_modules/@earendil-works/pi-ai');
      const nested = 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai';
      pkg(nested, '0.82.1', false);
      expect(run().status).toBe(1);
      pkg(nested);
      expect(run().status).toBe(0);
      pkg(nested, '0.83.0');
      expect(run().status).toBe(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('guards the common Nix runtime consumed by Operator and Fleet', () => {
    const flake = fs.readFileSync('flake.nix', 'utf8');
    const runtime = flake.slice(flake.indexOf('towerAppRuntime ='), flake.indexOf('towerAppRuntime =') + 2000);
    expect(runtime).toContain('node ../pi-sdk-checks/check-pi-sdk-runtime.mjs');
    expect(runtime).toContain('${./scripts/pi-sdk-behavior.mjs}');
    expect(runtime.indexOf('apply-pi-eventstream-patch')).toBeLessThan(runtime.indexOf('check-pi-sdk-runtime'));
  });
});
