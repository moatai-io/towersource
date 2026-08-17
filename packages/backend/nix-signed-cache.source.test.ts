import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(
  path.join(process.cwd(), 'scripts/nix-supply-chain', name),
  'utf8',
);
const publish = read('publish-signed-file-cache');
const prefetch = read('prefetch-signed-closure');
const rehearsal = read('rehearse-signed-file-cache');

describe('Nix signed binary cache S1 source contract', () => {
  it('keeps private signing material outside repository and workspace paths', () => {
    expect(publish).toContain('signing key must be outside repository/workspace');
    expect(publish).toContain('signing key permissions must not grant group/other access');
    expect(publish).toContain('dirty sourceRev cannot be promoted');
  });

  it('incrementally signs cache misses and publishes a complete closure', () => {
    expect(publish).toContain('store sign --key-file "$key_file" "${missing_paths[@]}"');
    expect(publish).toContain("narinfo=cache/f'{store_hash}.narinfo'");
    expect(publish).toContain("sig.startswith(key+':')");
    expect(publish).toContain('payload.is_file()');
    expect(publish).toContain('TOWER_NIX_CACHE_COMPRESSION:-zstd');
    expect(publish).toContain('TOWER_NIX_CACHE_COMPRESSION_LEVEL:-1');
    expect(publish).toContain('parallel-compression=$cache_parallel_compression');
    expect(publish).toContain('copy --no-recursive --to "$cache_uri" "${missing_paths[@]}"');
    expect(publish).not.toContain('copy --to "$cache_uri" "$store_path"');
    expect(publish).toContain('sourceRev collision');
    expect(publish).toContain('closurePathCount');
    expect(publish).toContain('publishedPathCount');
    expect(publish).toContain('reusedPathCount');
    expect(publish).not.toContain('--no-check-sigs');
  });

  it('prefetches with one trusted signature and can create a local GC root', () => {
    expect(prefetch).toContain('store verify --store "$cache_uri"');
    expect(prefetch).toContain('--option trusted-public-keys "$public_key"');
    expect(prefetch).toContain('--sigs-needed 1');
    expect(prefetch).toContain('verify_args=(store verify --no-trust)');
    expect(prefetch).toContain('[[ "$verification" = full ]] && verify_args+=(--recursive)');    expect(prefetch).toContain('ln -sfn "$store_path" "$gc_root"');
    expect(prefetch).not.toContain('--no-check-sigs');
    expect(prefetch).not.toContain('require-sigs = false');
  });

  it('rehearses wrong-key rejection, signature tampering, and cache outage survival', () => {
    expect(rehearsal).toContain('wrong public key unexpectedly accepted');
    expect(rehearsal).toContain('signature-stripped narinfo unexpectedly verified');
    expect(rehearsal).toContain('mv "$cache" "$cache.offline"');
    expect(rehearsal).toContain('offlineLocalClosure');
    expect(rehearsal).toContain('ephemeralKey');
  });
});
