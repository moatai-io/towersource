import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { execFileSync('chmod',['-R','u+w',d]);fs.rmSync(d,{recursive:true,force:true}); } });
describe('prebuilt Nix dist copy is writable only inside build workspace', () => {
  it('keeps read-only inputs immutable while copied migration files can be updated', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tower-prebuilt-perms-'));dirs.push(root);
    const input=path.join(root,'input');const build=path.join(root,'build');
    const migrations=path.join(input,'dist/backend/packages/backend/db/migrations');fs.mkdirSync(migrations,{recursive:true});
    fs.writeFileSync(path.join(migrations,'fixture.sql'),'old');fs.mkdirSync(build);
    execFileSync('chmod',['-R','a-w',input]);
    const before=fs.statSync(path.join(migrations,'fixture.sql')).mode;
    execFileSync('bash',['-c','cp -R "$1/dist" "$2/dist"; chmod -R u+w "$2/dist"; printf new > "$2/dist/backend/packages/backend/db/migrations/fixture.sql"','--',input,build]);
    expect(fs.readFileSync(path.join(migrations,'fixture.sql'),'utf8')).toBe('old');
    expect(fs.statSync(path.join(migrations,'fixture.sql')).mode).toBe(before);
    expect(fs.readFileSync(path.join(build,'dist/backend/packages/backend/db/migrations/fixture.sql'),'utf8')).toBe('new');
  });
  it('places the permission adjustment immediately after build-local copy, not on the Nix input', () => {
    const flake=fs.readFileSync(new URL('../../flake.nix',import.meta.url),'utf8');
    expect(flake).toMatch(/cp -R \$\{prebuiltDist\}\/dist \.\/dist[\s\S]*?chmod -R u\+w \.\/dist/);
    expect(flake).not.toMatch(/chmod[^\n]*\$\{prebuiltDist\}/);
  });
});
