import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-supply-chain/check-operator-cache-health'),
  'utf8',
);

describe('Nix operator cache health source contract', () => {
  it('is read-only and verifies the latest promoted closure signature unless promotion already proved it', () => {
    expect(source).toContain('Read-only health check');
    expect(source).toContain('--sigs-needed 1');
    expect(source).toContain('--recursive --sigs-needed 1');
    expect(source).toContain('--promotion-sign-copy-proven');
    expect(source).toContain('if (( promotion_sign_copy_proven ))');
    expect(source).toContain("'signatureVerificationSource':'promotion-root-after-sign-copy' if preverified=='1' else 'cache-health-recursive'");
    expect(source).toContain("rows[-1]");
    expect(source).not.toContain('upload-batch');
    expect(source).not.toContain('store sign');
    expect(source).not.toContain('rm -rf');
  });

  it('checks required mirror objects and exposes freshness and capacity', () => {
    expect(source).toContain("promotion-ledger.json");
    expect(source).toContain("nix-cache-info");
    expect(source).toContain('mirrorAgeSeconds');
    expect(source).toContain('localCacheBytes');
    expect(source).toContain("status='ok' if age <= int(max_age) else 'stale'");
    expect(source).toContain('mirror_json_file="$(mktemp)"');
    expect(source).toContain('health_meta_file="$(mktemp)"');
    expect(source).toContain('with open(sys.argv[1]) as f: rows=json.load(f)');
    expect(source).toContain('with open(sys.argv[2]) as f: meta=json.load(f)');
    expect(source).not.toContain('python3 - "$mirror_json"');
  });

  it('does not read or print private signing key content', () => {
    expect(source).toContain('privateKeyRead');
    expect(source).not.toContain('tower-cache-1.sec');
    expect(source).not.toContain('cat "$key_file"');
  });
});
