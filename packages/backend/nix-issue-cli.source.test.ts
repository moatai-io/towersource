import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('Nix backend GitHub CLI dependency', () => {
  it('includes gh in the production and offline probe wrappers', () => {
    const flake = read('flake.nix');
    for (const name of ['tower-app-start-production', 'tower-app-probe']) {
      const block = flake.split(`wrapProgram "$out/bin/${name}"`)[1]?.split('wrapProgram')[0];
      expect(block).toBeDefined();
      expect(block).toMatch(/--prefix PATH : \$\{lib\.makeBinPath \[[^\]]*pkgs\.gh[^\]]*\]\}/);
    }
  });

  it('probes the CLI without authentication or an external write', () => {
    const probe = read('scripts/nix-app/tower-app-probe');
    expect(probe).toContain('gh --version >/dev/null || fail');
    expect(probe).not.toMatch(/gh\s+(auth|api|issue)/);
  });
});
