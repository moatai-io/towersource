import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sync = fs.readFileSync(path.join(process.cwd(), 'scripts/fleet/customer-credential-sync'), 'utf8');
const exporter = fs.readFileSync(path.join(process.cwd(), 'packages/backend/scripts/credential-vault-export-cli.ts'), 'utf8');

describe('customer credential sync security contract', () => {
  it('requires an exact short-lived plan hash and explicit target', () => {
    expect(sync).toContain('expiresAt');
    expect(sync).toContain('approved plan hash missing, changed, or expired');
    expect(sync).toContain('--target CUSTOMER --credential ID');
    expect(sync).not.toContain('--all');
  });

  it('moves secret only through stdout-to-ssh stdin and never argv or disk', () => {
    expect(sync).toMatch(/credential-vault-export-cli[^\n]+\| ssh/);
    expect(sync).not.toContain('mktemp');
    expect(sync).not.toContain('echo "$value"');
    expect(exporter).toContain('console.log = (...values: unknown[]) => console.error(...values)');
    expect(exporter).toContain('process.stdout.write(value)');
    expect(exporter).not.toContain('console.log(value)');
  });

  it('uses the same operator actor for source list and export', () => {
    expect(sync).toContain('credential-vault-cli.ts list --json --by 1');
    expect(sync).toContain('credential-vault-export-cli.ts --id "$credential" --by 1');
    expect(sync).toContain('"actor":1');
  });

  it('separates the actual source credential scope from the workspace target scope', () => {
    expect(sync).toContain("'sourceCredentialScope':x['scope']");
    expect(sync).toContain("'targetScope':'workspace'");
    expect(sync).not.toContain("'scope':'workspace'");
    expect(sync).toContain('--scope workspace --by 1');
  });

  it('rejects unsafe source values, never exposes the secret, and grants every active target project', () => {
    expect(exporter).toContain('credential value is not safe for env materialization');
    expect(sync).toContain('SELECT id FROM projects WHERE archived IS NULL OR archived=0');
    expect(sync).toContain('grant-project');
    expect(sync).toContain('secretExposed":false');
  });
});
