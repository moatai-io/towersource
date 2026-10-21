import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retainFrontendAssets } from './retention.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-assets-test-')); roots.push(root);
  const frontend = path.join(root, 'release'); const data = path.join(root, 'data');
  fs.mkdirSync(path.join(frontend, 'assets'), { recursive: true });
  const write = (name: string, body: string) => fs.writeFileSync(path.join(frontend, 'assets', name), body);
  return { root, frontend, data, write };
}
describe('durable frontend assets', () => {
  it('keeps earlier JS and CSS after release replacement and repeated startup', () => {
    const f = fixture(); f.write('index-abcdefgh.js', 'old js'); f.write('index-abcdefgh.css', 'old css');
    const target = retainFrontendAssets(f.frontend, f.data);
    fs.rmSync(path.join(f.frontend, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(f.frontend, 'assets')); f.write('index-ijklmnop.js', 'new js');
    retainFrontendAssets(f.frontend, f.data); retainFrontendAssets(f.frontend, f.data);
    expect(fs.readFileSync(path.join(target, 'index-abcdefgh.js'), 'utf8')).toBe('old js');
    expect(fs.readFileSync(path.join(target, 'index-abcdefgh.css'), 'utf8')).toBe('old css');
    expect(fs.readFileSync(path.join(target, 'index-ijklmnop.js'), 'utf8')).toBe('new js');
  });
  it('excludes mutable files, subdirectories and symlinks', () => {
    const f = fixture(); f.write('runtime-config.js', 'private'); f.write('index.html', 'html');
    fs.symlinkSync('/nonexistent', path.join(f.frontend, 'assets', 'linked-abcdefgh.js'));
    const target = retainFrontendAssets(f.frontend, f.data);
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it('fails closed on same filename with different content', () => {
    const f = fixture(); f.write('index-abcdefgh.js', 'old'); retainFrontendAssets(f.frontend, f.data);
    f.write('index-abcdefgh.js', 'different');
    expect(() => retainFrontendAssets(f.frontend, f.data)).toThrow('collision');
  });
});

describe('production route wiring', () => {
  it('publishes retained assets before static HTML and prevents SPA fallback for missing assets', () => {
    const source = fs.readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    expect(source.indexOf('retainFrontendAssets(frontendPath, config.dataDir)')).toBeLessThan(source.indexOf('app.use(express.static(frontendPath'));
    expect(source.indexOf("app.use('/assets', (_req, res)")).toBeLessThan(source.indexOf("app.get('*'"));
    expect(source).toContain("res.status(404).end()");
  });
});
